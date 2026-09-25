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
  // sustantivos, verbos auxiliares y adjetivos comunes en verbos
  "ser",
  "tener",
  "todo",
  "toda",
  "acto",
  "efecto",
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

    // 1) Prefiltro en MongoDB: documentos cuyo 'spanish' o cuyo masdar_meaning
    //    contiene AL MENOS UNA de las palabras buscadas.
    //    Solo son letras (tokenize), así que no hay caracteres especiales de regex.
    const wordsToFind = onlyStopwords ? queryTokens : keywords;
    const regex = onlyStopwords
      ? wordsToFind.map((w) => `(?=.*${accentPattern(w)})`).join("")
      : wordsToFind.map(accentPattern).join("|");

    const collection = (await clientPromise)
      .db("quranic_arabic")
      .collection("dictionary");
    const candidates = await collection
      .find({
        $or: [
          { spanish: { $regex: regex, $options: "i" } },
          { "conjugation.masdar_meaning": { $regex: regex, $options: "i" } },
        ],
      })
      .toArray();

    // 2) Filtro por palabras completas, ignorando lo que está entre paréntesis.
    //    Devuelve null si no coincide, o { count, rank }:
    //    count = cuántas palabras de la búsqueda aparecen en la acepción (más = mejor)
    //    rank  = tipo de coincidencia (menor = mejor)
    const scoreMeaning = (meaning) => {
      const segs = segments(meaning);

      if (onlyStopwords) {
        // "de" solo encuentra acepciones que sean exactamente "de" (o "de / desde"…)
        return segs.includes(queryPhrase) ? { count: 1, rank: 0 } : null;
      }

      const words = segs.join(" ").split(" ");
      const matched = keywords.filter((k) => words.includes(k));
      if (matched.length === 0) return null;

      let rank = 2; // las palabras aparecen dentro de la acepción
      if (segs.includes(queryPhrase))
        rank = 0; // la acepción es exactamente lo buscado
      else if (segs.some((s) => matched.includes(s.split(" ")[0]))) rank = 1; // empieza con una de las palabras

      return { count: matched.length, rank };
    };

    const scoreList = (meanings, penalty = 0) =>
      (Array.isArray(meanings) ? meanings : [meanings])
        .filter((m) => typeof m === "string")
        .map(scoreMeaning)
        .filter(Boolean)
        .map(({ count, rank }) => ({ count, rank: rank + penalty }));

    // Primero más palabras coincidentes; a igual número, mejor tipo de coincidencia
    const compare = (a, b) => b.count - a.count || a.rank - b.rank;

    const results = candidates
      .map((doc) => {
        const scores = [
          ...scoreList(doc.spanish),
          // Coincidencias en el masdar: a igual relevancia, van después
          // de las coincidencias en 'spanish'
          ...scoreList(doc.conjugation?.masdar_meaning ?? [], 0.5),
        ];
        return scores.length ? { doc, score: scores.sort(compare)[0] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => compare(a.score, b.score))
      .map(({ doc }) => doc);

    return respond(200, results);
  } catch (error) {
    return respond(500, { error: error.toString() });
  }
};

module.exports = { handler };
