
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
const applications = database.collection("applications")

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


app.post("/applications", async (req, res) => {
    try {
        const {
            jobId,
            userId,
            email,
            jobTitle,
            companyName,
        } = req.body

        // Validate required fields
        if (!jobId || !userId || !email) {
            return res.status(400).json({
                success: false,
                message: "Required application information is missing",
            })
        }

        // Check whether the job exists
        if (!ObjectId.isValid(jobId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid job ID",
            })
        }

        const job = await jobs.findOne({
            _id: new ObjectId(jobId),
        })

        if (!job) {
            return res.status(404).json({
                success: false,
                message: "Job not found",
            })
        }

        if (job.status !== "active") {
            return res.status(400).json({
                success: false,
                message: "This job is not accepting applications",
            })
        }

        // Prevent duplicate applications
        const existingApplication = await applications.findOne({
            jobId,
            userId,
        })

        if (existingApplication) {
            return res.status(409).json({
                success: false,
                message: "You have already applied for this job",
            })
        }

        const newApplication = {
            jobId,
            userId,
            email,
            jobTitle: job.title,
            companyName: job.company,
            status: "pending",
            appliedAt: new Date(),
        }

        const result = await applications.insertOne(newApplication)

        res.status(201).json({
            success: true,
            message: "Application submitted successfully",
            insertedId: result.insertedId,
        })

    } catch (error) {
        console.error("Create Application Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to submit application",
        })
    }
})


// Check whether a seeker has applied for a job
app.get("/applications/check", async (req, res) => {
    try {
        const { jobId, userId } = req.query

        if (!jobId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Job ID and user ID are required",
            })
        }

        const application = await applications.findOne({
            jobId,
            userId,
        })

        res.status(200).json({
            success: true,
            hasApplied: Boolean(application),
        })
    } catch (error) {
        console.error("Check Application Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to check application",
        })
    }
})


// Withdraw an application
app.delete("/applications", async (req, res) => {
    try {
        const { jobId, userId } = req.body

        if (!jobId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Job ID and user ID are required",
            })
        }

        const result = await applications.deleteOne({
            jobId,
            userId,
        })

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Application not found",
            })
        }

        res.status(200).json({
            success: true,
            message: "Application withdrawn successfully",
        })
    } catch (error) {
        console.error("Withdraw Application Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to withdraw application",
        })
    }
})




// GET: Applications submitted by a seeker
app.get("/applications/seeker/:userId", async (req, res) => {
    try {
        const { userId } = req.params

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required",
            })
        }

        const seekerApplications = await applications
            .find({ userId })
            .sort({ appliedAt: -1 })
            .toArray()

        const enrichedApplications = await Promise.all(
            seekerApplications.map(async (application) => {
                let job = null

                if (ObjectId.isValid(application.jobId)) {
                    job = await jobs.findOne({
                        _id: new ObjectId(application.jobId),
                    })
                }

                return {
                    ...application,
                    _id: application._id.toString(),
                    jobTitle: job?.title ?? application.jobTitle,
                    companyName: job?.company ?? application.companyName,
                    location: job?.location ?? "",
                    employmentType: job?.employmentType ?? "",
                    workplaceType: job?.workplaceType ?? "",
                }
            })
        )

        res.status(200).json({
            success: true,
            applications: enrichedApplications,
        })
    } catch (error) {
        console.error("Get Seeker Applications Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to retrieve applications",
        })
    }
})

// GET: Applicants for a specific job (recruiter view)
app.get("/applications/job/:jobId", async (req, res) => {
    try {
        const { jobId } = req.params
        const { recruiterId } = req.query

        if (!ObjectId.isValid(jobId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid job ID",
            })
        }

        if (!recruiterId || typeof recruiterId !== "string") {
            return res.status(400).json({
                success: false,
                message: "Recruiter ID is required",
            })
        }

        const job = await jobs.findOne({
            _id: new ObjectId(jobId),
        })

        if (!job) {
            return res.status(404).json({
                success: false,
                message: "Job not found",
            })
        }

        // This assumes each job document stores its recruiter's ID
        // as recruiterId. Use the actual field from your job documents.
        if (job.recruiterId !== recruiterId) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to view these applicants",
            })
        }

        const jobApplications = await applications
            .find({ jobId })
            .sort({ appliedAt: -1 })
            .toArray()

        const enrichedApplicants = await Promise.all(
            jobApplications.map(async (application) => {
                const applicant = await users.findOne({
                    email: application.email,
                })

                return {
                    ...application,
                    _id: application._id.toString(),
                    applicantName:
                        applicant?.name ?? application.applicantName ?? "Unknown",
                    email: application.email,
                }
            })
        )

        res.status(200).json({
            success: true,
            job: {
                _id: job._id.toString(),
                title: job.title,
                company: job.company,
            },
            applicants: enrichedApplicants,
        })
    } catch (error) {
        console.error("Get Job Applicants Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to retrieve applicants",
        })
    }
})




app.get("/jobs", async (req, res) => {
    try {
        const query = {}

        // Get a query parameter as a string
        const getString = (value) => {
            if (typeof value === "string") {
                return value.trim()
            }
            return ""
        }

        // Escape special regex characters
        const escapeRegex = (value) => {
            return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }

        // Create case-insensitive regex
        const makeRegex = (value) => {
            return new RegExp(escapeRegex(value), "i")
        }

        // --------------------------------
        // 1. General text search
        // --------------------------------

        const search = getString(req.query.search)

        if (search) {
            const searchRegex = makeRegex(search)

            query.$or = [
                { title: searchRegex },
                { company: searchRegex },
                { category: searchRegex },
                { location: searchRegex },
                { description: searchRegex },
                { responsibilities: searchRegex },
                { requirements: searchRegex },
                { skills: searchRegex },
            ]
        }

        // --------------------------------
        // 2. Partial string filters
        // --------------------------------

        const stringFields = [
            "title",
            "company",
            "category",
            "location",
            "description",
            "responsibilities",
            "requirements",
        ]

        stringFields.forEach((field) => {
            const value = getString(req.query[field])

            if (value) {
                query[field] = makeRegex(value)
            }
        })

        // --------------------------------
        // 3. Exact enum filters
        // --------------------------------

        const enumFields = [
            "employmentType",
            "workplaceType",
            "experience",
            "currency",
            "status",
        ]

        enumFields.forEach((field) => {
            const value = getString(req.query[field])

            if (value) {
                query[field] = makeRegex(value)
            }
        })

        // --------------------------------
        // 4. Skills array filter
        // --------------------------------

        let skills = req.query.skills || []

        if (!Array.isArray(skills)) {
            skills = [skills]
        }

        skills = skills
            .flatMap((skill) => String(skill).split(","))
            .map((skill) => skill.trim())
            .filter(Boolean)

        if (skills.length > 0) {
            query.skills = {
                $in: skills.map((skill) => makeRegex(skill)),
            }
        }

        // --------------------------------
        // 5. Salary filters
        // --------------------------------

        const minSalaryValue = getString(req.query.salaryMin)
        const maxSalaryValue = getString(req.query.salaryMax)

        const minSalary = minSalaryValue
            ? Number(minSalaryValue)
            : null

        const maxSalary = maxSalaryValue
            ? Number(maxSalaryValue)
            : null

        if (
            (minSalary !== null &&
                (!Number.isFinite(minSalary) || minSalary < 0)) ||
            (maxSalary !== null &&
                (!Number.isFinite(maxSalary) || maxSalary < 0)) ||
            (minSalary !== null &&
                maxSalary !== null &&
                minSalary > maxSalary)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid salary range",
            })
        }

        // Job's minimum salary must be >= requested minimum
        if (minSalary !== null) {
            query.salaryMin = { $gte: minSalary }
        }

        // Job's maximum salary must be <= requested maximum
        if (maxSalary !== null) {
            query.salaryMax = { $lte: maxSalary }
        }

        // --------------------------------
        // 6. Application deadline filters
        // --------------------------------

        const deadlineBefore = getString(req.query.deadlineBefore)
        const deadlineAfter = getString(req.query.deadlineAfter)

        if (deadlineBefore || deadlineAfter) {
            query.applicationDeadline = {}

            if (deadlineBefore) {
                query.applicationDeadline.$lte = deadlineBefore
            }

            if (deadlineAfter) {
                query.applicationDeadline.$gte = deadlineAfter
            }
        }

        // --------------------------------
        // 7. Fetch filtered jobs
        // --------------------------------

        const result = await jobs.find(query).toArray()

        // Convert MongoDB ObjectId to string
        const formattedJobs = result.map((job) => ({
            ...job,
            _id: job._id.toString(),
        }))

        res.status(200).json(formattedJobs)

    } catch (error) {
        console.error("Error fetching jobs:", error)

        res.status(500).json({
            success: false,
            message: "Failed to fetch jobs",
            error: error.message,
        })
    }
})









app.delete("/jobs/:id", async (req, res) => {
    try {
        const { id } = req.params

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid job ID",
            })
        }

        const result = await jobs.deleteOne({
            _id: new ObjectId(id),
        })

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Job not found",
            })
        }

        res.status(200).json({
            success: true,
            message: "Job deleted successfully",
        })
    } catch (error) {
        console.error("Delete Job Error:", error)

        res.status(500).json({
            success: false,
            message: "Failed to delete job",
        })
    }
})



// get job details page 

app.get("/jobs/:id", async (req, res) => {
    try {
        const { id } = req.params

        // Validate MongoDB ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).send({
                message: "Invalid job ID",
            })
        }

        // Find the selected job
        const job = await jobs.findOne({
            _id: new ObjectId(id),
        })

        // Check whether the job exists
        if (!job) {
            return res.status(404).send({
                message: "Job not found",
            })
        }

        // Return the selected job
        res.status(200).send({
            ...job,
            _id: job._id.toString(),
        })
    } catch (error) {
        console.error("Failed to fetch job:", error)

        res.status(500).send({
            message: "Failed to fetch job details",
        })
    }
})


// Root route
app.get("/", (req, res) => {
    res.send("Hire Loop is looping!")
})

// Start server
app.listen(port, () => {
    console.log(`Hireloop is listening on port ${port}`)
})
