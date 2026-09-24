const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;

let client; // se reutiliza entre invocaciones

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
};

function hashFecha(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    if (!client) client = new MongoClient(MONGO_URI);

    const hoy = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    });

    const col = client.db("quranic_arabic").collection("dictionary");
    const total = await col.estimatedDocumentCount();
    const indice = hashFecha(hoy) % total;

    const [palabra] = await col
      .find({}, { projection: { arabic_sg: 1, translit_sg: 1, spanish: 1 } })
      .sort({ _id: 1 })
      .skip(indice)
      .limit(1)
      .toArray();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fecha: hoy, ...palabra }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
