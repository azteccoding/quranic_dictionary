const { MongoClient, ObjectId } = require("mongodb");

const mongoClient = new MongoClient(process.env.MONGO_URI);

const clientPromise = mongoClient.connect();

const HEADERS = {
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept, x-api-key",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, OPTIONS",
  "Content-Type": "application/json",
  Vary: "Origin",
};

const respond = (statusCode, data) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(data),
});

// Misma normalización que usan arabic.js y create_word.js
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

// Campos que nunca se pueden tocar desde aquí
const PROTECTED = ["_id", "created_at", "updated_at"];

const toList = (value) => (Array.isArray(value) ? value : [value]);

// Normaliza los valores según el campo, igual que al crear
const normalize = (field, value) => {
  if (field === "spanish") {
    return [
      ...new Set(
        toList(value)
          .filter((s) => typeof s === "string")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }
  if (field === "arabic_pl") {
    return toList(value)
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => removeHarakats(p.trim()));
  }
  // arabic_sg, conjugation.masdar, participle…, o un objeto completo como "conjugation"
  return normalizeArabic(field, value);
};

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

const handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") return respond(204, {});

  if (event.httpMethod !== "PATCH") {
    return respond(405, { error: "Método no permitido. Usa PATCH." });
  }

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

  const { id, set = {}, add = {}, remove = {} } = body;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return respond(400, { error: "Falta 'id' o no es un ObjectId válido" });
  }
  if (![set, add, remove].every(isPlainObject)) {
    return respond(400, { error: "'set', 'add' y 'remove' deben ser objetos" });
  }

  // Validación de nombres de campo
  const allFields = [
    ...Object.keys(set),
    ...Object.keys(add),
    ...Object.keys(remove),
  ];
  if (allFields.length === 0) {
    return respond(400, { error: "No hay nada que actualizar" });
  }
  for (const field of allFields) {
    if (field.startsWith("$") || PROTECTED.includes(field.split(".")[0])) {
      return respond(400, {
        error: `El campo '${field}' no se puede modificar`,
      });
    }
  }
  const repeated = allFields.filter((f, i) => allFields.indexOf(f) !== i);
  if (repeated.length) {
    return respond(400, {
      error: `Un campo solo puede ir en una operación: ${[...new Set(repeated)].join(", ")}`,
    });
  }

  // Construcción de la actualización
  const $set = { updated_at: new Date() };
  for (const [field, value] of Object.entries(set)) {
    $set[field] = normalize(field, value);
  }
  if ("spanish" in set && $set.spanish.length === 0) {
    return respond(400, { error: "'spanish' no puede quedar vacío" });
  }
  if (
    "arabic_sg" in set &&
    (typeof $set.arabic_sg !== "string" || !$set.arabic_sg)
  ) {
    return respond(400, { error: "'arabic_sg' no puede quedar vacío" });
  }

  const $addToSet = {};
  for (const [field, value] of Object.entries(add)) {
    $addToSet[field] = { $each: toList(normalize(field, value)) };
  }

  const $pull = {};
  for (const [field, value] of Object.entries(remove)) {
    $pull[field] = { $in: toList(normalize(field, value)) };
  }

  const update = { $set };
  if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
  if (Object.keys($pull).length) update.$pull = $pull;

  try {
    const collection = (await clientPromise)
      .db("quranic_arabic")
      .collection("dictionary");

    const _id = new ObjectId(id);
    const current = await collection.findOne({ _id });
    if (!current) {
      return respond(404, { error: "No existe una palabra con ese id" });
    }

    // Cómo quedarían los significados después del cambio
    const added = $addToSet.spanish?.$each ?? [];
    const removed = $pull.spanish?.$in ?? [];
    const finalSpanish = [
      ...new Set([
        ...($set.spanish ?? toList(current.spanish ?? [])),
        ...added,
      ]),
    ].filter((s) => !removed.includes(s));

    if (finalSpanish.length === 0) {
      return respond(400, { error: "No puedes quitar todos los significados" });
    }

    // Evita que la edición produzca un duplicado de otra entrada.
    // Si cambió la palabra árabe se revisan todos los significados;
    // si no, solo los que se están agregando.
    const finalArabic = $set.arabic_sg ?? current.arabic_sg;
    const toCheck =
      "arabic_sg" in $set
        ? finalSpanish
        : [...($set.spanish ?? []), ...added].filter(
            (s) => !toList(current.spanish ?? []).includes(s),
          );

    if (toCheck.length) {
      const clash = await collection.findOne({
        _id: { $ne: _id },
        arabic_sg: finalArabic,
        spanish: { $in: toCheck },
      });
      if (clash) {
        return respond(409, {
          error: "Otra entrada ya tiene esa palabra con ese significado",
          word: clash,
        });
      }
    }

    const updated = await collection.findOneAndUpdate({ _id }, update, {
      returnDocument: "after",
    });

    return respond(200, updated);
  } catch (error) {
    return respond(500, { error: error.toString() });
  }
};

module.exports = { handler };
