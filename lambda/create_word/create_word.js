const { MongoClient } = require("mongodb");

const mongoClient = new MongoClient(process.env.MONGO_URI);

const clientPromise = mongoClient.connect();

const HEADERS = {
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept, x-api-key",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  Vary: "Origin",
};

const respond = (statusCode, data) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(data),
});

// Misma normalización que usa arabic.js al buscar
const removeHarakats = (text) => text.replace(/[ً-ْ]/gm, "");

// Campos de palabra (no oraciones ni citas) a los que se les quitan las harakat.
// Las oraciones del Corán, hadices, frases y additionals conservan su vocalización.
const ARABIC_WORD_PATHS = [
  "arabic_sg",
  "arabic_pl",
  "definite_sg",
  "indefNoun",
  "root",
  "synonim",
  "antonym",
  "conjugation.root",
  "conjugation.perfect3",
  "conjugation.perfect1",
  "conjugation.masdar",
  "participle.active.arabic",
  "participle.pasive.arabic",
];

const stripValue = (value) => {
  if (typeof value === "string") return removeHarakats(value.trim());
  if (Array.isArray(value)) return value.map(stripValue);
  return value;
};

// Recorre el valor según su ruta ("conjugation", "conjugation.masdar"…)
// y quita harakat solo en las rutas de ARABIC_WORD_PATHS
const normalizeArabic = (path, value) => {
  if (ARABIC_WORD_PATHS.includes(path)) return stripValue(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        normalizeArabic(path ? `${path}.${k}` : k, v),
      ]),
    );
  }
  return value;
};

const handler = async (event, context) => {
  // Preflight de CORS (el navegador lo envía antes del POST)
  if (event.httpMethod === "OPTIONS") return respond(204, {});

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Método no permitido. Usa POST." });
  }

  // Protección básica: solo quien tenga la clave puede escribir
  if (
    process.env.API_KEY &&
    event.headers["x-api-key"] !== process.env.API_KEY
  ) {
    return respond(401, { error: "No autorizado" });
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    body = JSON.parse(raw || "{}");
  } catch {
    return respond(400, { error: "El cuerpo debe ser JSON válido" });
  }

  // _id lo genera Mongo; se ignora si viene en el cuerpo
  const { _id, arabic_sg, spanish, arabic_pl, ...rest } = body;

  if (typeof arabic_sg !== "string" || !arabic_sg.trim()) {
    return respond(400, { error: "Falta el campo 'arabic_sg'" });
  }

  // spanish es un arreglo de significados; se acepta también un solo string
  const spanishList = [
    ...new Set(
      (Array.isArray(spanish) ? spanish : [spanish])
        .filter((s) => typeof s === "string")
        .map((s) => s.trim().toLowerCase()) // igual que la búsqueda en spanish.js
        .filter(Boolean),
    ),
  ];
  if (spanishList.length === 0) {
    return respond(400, {
      error: "'spanish' debe ser un arreglo con al menos un significado",
    });
  }

  const word = {
    spanish: spanishList,
    // english, translit_*, quranic_appear, conjugation, etc.;
    // a los campos de palabra en árabe se les quitan las harakat
    ...normalizeArabic("", rest),
    arabic_sg: removeHarakats(arabic_sg.trim()), // sin harakat, como busca arabic.js
    arabic_pl: (Array.isArray(arabic_pl)
      ? arabic_pl
      : arabic_pl
        ? [arabic_pl]
        : []
    )
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => removeHarakats(p.trim())),
    created_at: new Date(),
  };

  try {
    const collection = (await clientPromise)
      .db("quranic_arabic")
      .collection("dictionary");

    // Duplicado = misma palabra árabe que ya tenga alguno de estos significados.
    // Homógrafos con otro significado sí se permiten.
    const existing = await collection.findOne({
      arabic_sg: word.arabic_sg,
      spanish: { $in: word.spanish },
    });
    if (existing) {
      return respond(409, { error: "Esa palabra ya existe", word: existing });
    }

    const result = await collection.insertOne(word);
    return respond(201, { _id: result.insertedId, ...word });
  } catch (error) {
    return respond(500, { error: error.toString() });
  }
};

module.exports = { handler };
