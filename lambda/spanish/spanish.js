const { MongoClient } = require("mongodb");

const mongoClient = new MongoClient(process.env.MONGO_URI);

const clientPromise = mongoClient.connect();

const HEADERS = {
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  Vary: "Origin",
};

// Palabras que se ignoran dentro de una búsqueda de varias palabras.
// Si el usuario busca SOLO palabras de esta lista ("de", "por lo que"),
// se busca ese significado exacto.
const STOPWORDS = new Set([
  // preposiciones
  "a",
  "al",
  "ante",
  "bajo",
  "con",
  "contra",
  "de",
  "del",
  "desde",
  "en",
  "entre",
  "hacia",
  "hasta",
  "para",
  "por",
  "segun",
  "sin",
  "sobre",
  "tras",
  // conjunciones
  "y",
  "e",
  "o",
  "u",
  "ni",
  "que",
  "pero",
  "sino",
  "si",
  "como",
  // artículos y pronombres frecuentes en las definiciones
  "el",
  "la",
  "los",
  "las",
  "lo",
  "un",
  "una",
  "unos",
  "unas",
  "se",
  "su",
  "sus",
  "algo",
  "algn",
  "alguien",
]);

// Minúsculas y sin acentos (conserva la ñ): "Canción" -> "cancion"
const normalizeText = (text) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-̂̄-ͯ]/g, "") // quita acentos, deja la tilde de la ñ
    .normalize("NFC");

const tokenize = (text) => normalizeText(text).match(/\p{L}+/gu) ?? [];

// Quita lo que está entre paréntesis: "tocar con el dedo (ه algo)" -> "tocar con el dedo "
const stripParentheses = (text) => text.replace(/\([^)]*\)/g, " ");

// Divide una acepción en segmentos normalizados:
// "preguntar / consultar (عن sobre algo)" -> ["preguntar", "consultar"]
const segments = (meaning) =>
  stripParentheses(meaning)
    .split(/[\/,;]/)
    .map((s) => tokenize(s).join(" "))
    .filter(Boolean);

// Regex tolerante a acentos para prefiltrar en MongoDB: "cancion" -> "canci[oóòö]n"
const ACCENTS = { a: "aáàä", e: "eéèë", i: "iíìï", o: "oóòö", u: "uúùü" };
const accentPattern = (word) =>
  [...word].map((c) => (ACCENTS[c] ? `[${ACCENTS[c]}]` : c)).join("");

const respond = (statusCode, data) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(data),
});

const handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") return respond(204, {});

  try {
    const searchWord = event.queryStringParameters?.word ?? "";
    const queryTokens = tokenize(searchWord);

    if (queryTokens.length === 0) {
      return respond(400, { error: "Falta el parámetro 'word'" });
    }

    const keywords = queryTokens.filter((t) => !STOPWORDS.has(t));
    const onlyStopwords = keywords.length === 0;
    const queryPhrase = queryTokens.join(" ");

    // 1) Prefiltro en MongoDB: documentos cuyo 'spanish' contiene esas letras.
    //    Solo son letras (tokenize), así que no hay caracteres especiales de regex.
    const wordsToFind = onlyStopwords ? queryTokens : keywords;
    const regex = wordsToFind.map((w) => `(?=.*${accentPattern(w)})`).join("");

    const collection = (await clientPromise)
      .db("quranic_arabic")
      .collection("dictionary");
    const candidates = await collection
      .find({ spanish: { $regex: regex, $options: "i" } })
      .toArray();

    // 2) Filtro exacto por palabras completas, ignorando lo que está entre paréntesis.
    //    Devuelve null si no coincide, o una puntuación (menor = más relevante).
    const scoreMeaning = (meaning) => {
      const segs = segments(meaning);

      if (onlyStopwords) {
        // "de" solo encuentra acepciones que sean exactamente "de" (o "de / desde"…)
        return segs.includes(queryPhrase) ? 0 : null;
      }

      const words = segs.join(" ").split(" ");
      if (!keywords.every((k) => words.includes(k))) return null;

      if (segs.includes(queryPhrase)) return 0; // la acepción es exactamente lo buscado
      if (segs.some((s) => s.split(" ")[0] === keywords[0])) return 1; // empieza con la palabra
      return 2; // la palabra aparece dentro de la acepción
    };

    const results = candidates
      .map((doc) => {
        const scores = (
          Array.isArray(doc.spanish) ? doc.spanish : [doc.spanish]
        )
          .filter((m) => typeof m === "string")
          .map(scoreMeaning)
          .filter((s) => s !== null);
        return scores.length ? { doc, score: Math.min(...scores) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score) // primero las coincidencias exactas
      .map(({ doc }) => doc);

    return respond(200, results);
  } catch (error) {
    return respond(500, { error: error.toString() });
  }
};

module.exports = { handler };
