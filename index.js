
import cors from "cors"
import "dotenv/config"
import express from "express"
import { MongoClient, ObjectId } from "mongodb"

const app = express()
const port = process.env.PORT || 8000

// Middleware
app.use(express.json())
app.use(cors())

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URL)

export async function connectToMongoDB() {
    try {
        await client.connect()
        console.log("You successfully connected to MongoDB Database..!")
        return client
    } catch (err) {
        console.error("MongoDB connection failed:", err)
        throw err
    }
}

// Database and collections
await connectToMongoDB()

const database = client.db("hireloop")

const users = database.collection("user")
const jobs = database.collection("jobs")

// Get all users
app.get("/users", async (req, res) => {
    try {
        const result = await users.find({}).toArray()
        res.status(200).json(result)
    } catch (error) {
        console.error("Get Users Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to retrieve users",
        })
    }
})

// Create a new job
app.post("/jobs", async (req, res) => {
    try {
        const job = req.body

        // Basic validation
        if (
            !job.title ||
            !job.company ||
            !job.category ||
            !job.description
        ) {
            return res.status(400).json({
                success: false,
                message: "Required job information is missing",
            })
        }

        const newJob = {
            ...job,
            status: job.status || "published",
            createdAt: new Date(),
            updatedAt: new Date(),
        }

        const result = await jobs.insertOne(newJob)

        res.status(201).json({
            success: true,
            message: "Job created successfully",
            insertedId: result.insertedId,
        })
    } catch (error) {
        console.error("Create Job Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to create job",
        })
    }
})


app.get('/jobs', async(req, res) =>{
    const cursor = jobs.find();
    const result = await cursor.toArray();
    res.send(result);
})
app.delete('/jobs/:id', async(req, res) =>{
    const id = req.params.id;
    const query = {_id: new ObjectId(id)};
    const result = await jobs.deleteOne(query);
    res.send(result);
})

// Root route
app.get("/", (req, res) => {
    res.send("Hire Loop is looping!")
})

// Start server
app.listen(port, () => {
    console.log(`Hireloop is listening on port ${port}`)
})
