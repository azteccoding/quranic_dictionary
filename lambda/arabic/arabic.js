const { MongoClient } = require("mongodb");

const mongoClient = new MongoClient(process.env.MONGO_URI);

const clientPromise = mongoClient.connect();

const handler = async (request, context) => {
  try {
    const searchWord = request.queryStringParameters?.word;
    const database = (await clientPromise).db("quranic_arabic");
    const collection = database.collection("dictionary");
    const results = await collection.find({ arabic_sg: searchWord }).toArray();
    return {
      headers: {
        "Access-Control-Allow-Headers":
          "Origin, X-Requested-With, Content-Type, Accept",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        Vary: "Origin",
      },
      statusCode: 200,
      body: JSON.stringify(results),
    };
  } catch (error) {
    return { statusCode: 500, body: error.toString() };
  }
};

module.exports = { handler };
