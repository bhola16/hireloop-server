
import cors from "cors"
import "dotenv/config"
import express from "express"
import { MongoClient, ObjectId } from "mongodb"

const app = express()
const port = process.env.PORT || 8000
const FREE_APPLICATION_LIMIT = 5
const APPLICATION_FEE_BDT = Number(process.env.APPLICATION_FEE_BDT || 20)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"

// Middleware
app.use(express.json())
app.use(
    cors({
        origin: FRONTEND_URL,
        credentials: true,
    })
)

// MongoDB
if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is missing from environment variables")
}

const client = new MongoClient(process.env.MONGODB_URL)
const database = client.db("hireloop")

const users = database.collection("user")
const jobs = database.collection("jobs")
const applications = database.collection("applications")
const applicationUsage = database.collection("applicationUsage")
const applicationPayments = database.collection("applicationPayments")

// Reusable async handler: route errors go to the central error middleware.
const asyncHandler = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next)

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message)
        this.status = status
        this.extra = extra
    }
}

const isValidId = (id) => typeof id === "string" && ObjectId.isValid(id)

const getCurrentMonth = () => {
    const now = new Date()
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

const getCurrentMonthRange = () => {
    const now = new Date()
    return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    }
}

// Count both Date values and ISO strings to support existing records.
const countApplicationsThisMonth = async (userId) => {
    const { start, end } = getCurrentMonthRange()

    return applications.countDocuments({
        userId,
        $or: [
            { appliedAt: { $gte: start, $lt: end } },
            {
                appliedAt: {
                    $gte: start.toISOString(),
                    $lt: end.toISOString(),
                },
            },
        ],
    })
}

// Create a monthly usage document the first time a seeker is checked.
// Existing applications from the current month are included.
const getOrCreateMonthlyUsage = async (userId) => {
    const monthKey = getCurrentMonth()

    try {
        await applicationUsage.updateOne(
            { userId, monthKey },
            {
                $setOnInsert: {
                    userId,
                    monthKey,
                    count: await countApplicationsThisMonth(userId),
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        )
    } catch (error) {
        // Another request may have created this unique record concurrently.
        if (error.code !== 11000) throw error
    }

    return applicationUsage.findOne({ userId, monthKey })
}

const createIndexes = async () => {
    await applications.createIndex(
        { userId: 1, jobId: 1 },
        { unique: true, name: "unique_user_job_application" }
    )

    await applicationUsage.createIndex(
        { userId: 1, monthKey: 1 },
        { unique: true, name: "unique_user_month_usage" }
    )

    await applicationPayments.createIndex(
        { userId: 1, jobId: 1, monthKey: 1, status: 1 }
    )

    await applicationPayments.createIndex(
        { userId: 1, monthKey: 1, createdAt: -1 }
    )
}

// -----------------------------------------------------------------------------
// USERS
// -----------------------------------------------------------------------------

app.get(
    "/users",
    asyncHandler(async (req, res) => {
        const result = await users.find({}).toArray()
        res.status(200).json(result)
    })
)

// -----------------------------------------------------------------------------
// JOBS
// -----------------------------------------------------------------------------

app.post(
    "/jobs",
    asyncHandler(async (req, res) => {
        const job = req.body

        if (!job.title?.trim() || !job.company?.trim() ||
            !job.category?.trim() || !job.description?.trim()) {
            throw new HttpError(400, "Required job information is missing")
        }

        if (!job.recruiterId) {
            throw new HttpError(400, "Recruiter ID is required")
        }

        const now = new Date().toISOString()
        const newJob = {
            ...job,
            createdAt: now,
            updatedAt: now,
        }

        const result = await jobs.insertOne(newJob)

        res.status(201).json({
            success: true,
            message: "Job created successfully",
            insertedId: result.insertedId,
        })
    })
)

app.get(
    "/jobs",
    asyncHandler(async (req, res) => {
        const query = {}

        const getString = (value) =>
            typeof value === "string" ? value.trim() : ""

        const escapeRegex = (value) =>
            value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

        const makeRegex = (value) =>
            new RegExp(escapeRegex(value), "i")

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
            if (value) query[field] = makeRegex(value)
        })

        const enumFields = [
            "employmentType",
            "workplaceType",
            "experience",
            "currency",
            "status",
        ]

        enumFields.forEach((field) => {
            const value = getString(req.query[field])
            if (value) query[field] = makeRegex(value)
        })

        let skills = req.query.skills || []
        if (!Array.isArray(skills)) skills = [skills]

        skills = skills
            .flatMap((skill) => String(skill).split(","))
            .map((skill) => skill.trim())
            .filter(Boolean)

        if (skills.length) {
            query.skills = { $in: skills.map(makeRegex) }
        }

        const minSalaryValue = getString(req.query.salaryMin)
        const maxSalaryValue = getString(req.query.salaryMax)
        const minSalary = minSalaryValue ? Number(minSalaryValue) : null
        const maxSalary = maxSalaryValue ? Number(maxSalaryValue) : null

        if (
            (minSalary !== null && (!Number.isFinite(minSalary) || minSalary < 0)) ||
            (maxSalary !== null && (!Number.isFinite(maxSalary) || maxSalary < 0)) ||
            (minSalary !== null && maxSalary !== null && minSalary > maxSalary)
        ) {
            throw new HttpError(400, "Invalid salary range")
        }

        if (minSalary !== null) query.salaryMin = { $gte: minSalary }
        if (maxSalary !== null) query.salaryMax = { $lte: maxSalary }

        const deadlineBefore = getString(req.query.deadlineBefore)
        const deadlineAfter = getString(req.query.deadlineAfter)

        if (deadlineBefore || deadlineAfter) {
            query.applicationDeadline = {}
            if (deadlineBefore) query.applicationDeadline.$lte = deadlineBefore
            if (deadlineAfter) query.applicationDeadline.$gte = deadlineAfter
        }

        const result = await jobs.find(query).toArray()
        res.status(200).json(
            result.map((job) => ({ ...job, _id: job._id.toString() }))
        )
    })
)

app.get(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
        const { id } = req.params
        if (!isValidId(id)) throw new HttpError(400, "Invalid job ID")

        const job = await jobs.findOne({ _id: new ObjectId(id) })
        if (!job) throw new HttpError(404, "Job not found")

        res.status(200).json({ ...job, _id: job._id.toString() })
    })
)

app.delete(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
        const { id } = req.params
        if (!isValidId(id)) throw new HttpError(400, "Invalid job ID")

        const result = await jobs.deleteOne({ _id: new ObjectId(id) })
        if (!result.deletedCount) throw new HttpError(404, "Job not found")

        res.status(200).json({
            success: true,
            message: "Job deleted successfully",
        })
    })
)

app.put(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
        const { id } = req.params
        const { recruiterId, ...data } = req.body

        if (!isValidId(id)) throw new HttpError(400, "Invalid job ID")
        if (!recruiterId) throw new HttpError(400, "Recruiter ID is required")

        const existingJob = await jobs.findOne({ _id: new ObjectId(id) })
        if (!existingJob) throw new HttpError(404, "Job not found")

        if (existingJob.recruiterId !== recruiterId) {
            throw new HttpError(403, "You are not authorized to edit this job")
        }

        const allowedFields = [
            "title",
            "company",
            "category",
            "employmentType",
            "workplaceType",
            "location",
            "experience",
            "salaryMin",
            "salaryMax",
            "currency",
            "description",
            "responsibilities",
            "requirements",
            "skills",
            "applicationDeadline",
            "status",
        ]

        const updateData = Object.fromEntries(
            allowedFields
                .filter((field) => data[field] !== undefined)
                .map((field) => [field, data[field]])
        )

        if (!Object.keys(updateData).length) {
            throw new HttpError(400, "No fields provided for update")
        }

        if (
            (updateData.title !== undefined && !updateData.title?.trim()) ||
            (updateData.company !== undefined && !updateData.company?.trim())
        ) {
            throw new HttpError(400, "Job title and company cannot be empty")
        }

        const { salaryMin, salaryMax } = updateData

        if (
            (salaryMin !== undefined && (!Number.isFinite(salaryMin) || salaryMin < 0)) ||
            (salaryMax !== undefined && (!Number.isFinite(salaryMax) || salaryMax < 0))
        ) {
            throw new HttpError(400, "Invalid salary amount")
        }

        if (
            salaryMin !== undefined &&
            salaryMax !== undefined &&
            salaryMin > salaryMax
        ) {
            throw new HttpError(400, "Minimum salary cannot exceed maximum salary")
        }

        if (
            updateData.status !== undefined &&
            !["active", "draft", "closed"].includes(updateData.status)
        ) {
            throw new HttpError(400, "Invalid job status")
        }

        if (
            updateData.skills !== undefined &&
            !Array.isArray(updateData.skills)
        ) {
            throw new HttpError(400, "Skills must be an array")
        }

        updateData.updatedAt = new Date().toISOString()

        await jobs.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        )

        const updatedJob = await jobs.findOne({ _id: new ObjectId(id) })

        res.status(200).json({
            success: true,
            message: "Job updated successfully",
            job: updatedJob,
        })
    })
)

// -----------------------------------------------------------------------------
// APPLICATION USAGE
// -----------------------------------------------------------------------------

app.get(
    "/applications/usage",
    asyncHandler(async (req, res) => {
        const { userId } = req.query
        if (typeof userId !== "string" || !userId) {
            throw new HttpError(400, "User ID is required")
        }

        const usage = await getOrCreateMonthlyUsage(userId)
        const count = usage?.count || 0

        res.status(200).json({
            success: true,
            month: getCurrentMonth(),
            limit: FREE_APPLICATION_LIMIT,
            totalApplications: count,
            freeApplicationsUsed: Math.min(count, FREE_APPLICATION_LIMIT),
            freeApplicationsRemaining: Math.max(FREE_APPLICATION_LIMIT - count, 0),
            paymentRequired: count >= FREE_APPLICATION_LIMIT,
        })
    })
)

// Keep the existing lifetime count endpoint for compatibility.
app.get(
    "/applications/count",
    asyncHandler(async (req, res) => {
        const { userId } = req.query
        if (typeof userId !== "string" || !userId) {
            throw new HttpError(400, "User ID is required")
        }

        const count = await applications.countDocuments({ userId })
        res.status(200).json({ success: true, count })
    })
)

// -----------------------------------------------------------------------------
// DEMO PAYMENT
// -----------------------------------------------------------------------------

app.post(
    "/applications/demo-payment",
    asyncHandler(async (req, res) => {
        const { userId, jobId } = req.body

        if (!userId || !jobId) {
            throw new HttpError(400, "User ID and Job ID are required")
        }

        if (!isValidId(jobId)) throw new HttpError(400, "Invalid job ID")

        const job = await jobs.findOne({ _id: new ObjectId(jobId) })
        if (!job) throw new HttpError(404, "Job not found")

        if (job.status !== "active") {
            throw new HttpError(400, "This job is not accepting applications")
        }

        const existingApplication = await applications.findOne({ userId, jobId })
        if (existingApplication) {
            throw new HttpError(409, "You have already applied for this job")
        }

        const usage = await getOrCreateMonthlyUsage(userId)
        if ((usage?.count || 0) < FREE_APPLICATION_LIMIT) {
            throw new HttpError(400, "You still have free applications available")
        }

        const payment = {
            userId,
            jobId,
            monthKey: getCurrentMonth(),
            amount: APPLICATION_FEE_BDT,
            currency: "BDT",
            method: "demo",
            status: "succeeded",
            usedAt: null,
            createdAt: new Date(),
        }

        const result = await applicationPayments.insertOne(payment)

        res.status(201).json({
            success: true,
            message: "Demo payment successful",
            paymentId: result.insertedId.toString(),
            payment: {
                amount: payment.amount,
                currency: payment.currency,
                method: payment.method,
                status: payment.status,
            },
        })
    })
)

// -----------------------------------------------------------------------------
// SUBMIT APPLICATION
// Both paths are supported so the existing frontend can keep using /applications.
// -----------------------------------------------------------------------------

const submitApplication = asyncHandler(async (req, res) => {
    const { jobId, userId, email, paymentId } = req.body

    if (!jobId || !userId || !email) {
        throw new HttpError(400, "Job ID, user ID and email are required")
    }

    if (!isValidId(jobId)) throw new HttpError(400, "Invalid job ID")
    if (paymentId && !isValidId(paymentId)) {
        throw new HttpError(400, "Invalid payment ID")
    }

    const job = await jobs.findOne({ _id: new ObjectId(jobId) })
    if (!job) throw new HttpError(404, "Job not found")

    if (job.status !== "active") {
        throw new HttpError(400, "This job is not accepting applications")
    }

    const existingApplication = await applications.findOne({ jobId, userId })
    if (existingApplication) {
        throw new HttpError(409, "You have already applied for this job")
    }

    await getOrCreateMonthlyUsage(userId)
    const monthKey = getCurrentMonth()

    let usageIncremented = false
    let consumedPaymentId = null

    try {
        // Reserve one free application atomically if the seeker is below five.
        const freeReservation = await applicationUsage.updateOne(
            {
                userId,
                monthKey,
                count: { $lt: FREE_APPLICATION_LIMIT },
            },
            { $inc: { count: 1 } }
        )

        let paymentMethod = "free"

        if (freeReservation.modifiedCount === 1) {
            usageIncremented = true

            if (paymentId) {
                throw new HttpError(400, "Payment is not required for this application")
            }
        } else {
            // All five free applications have already been used.
            if (!paymentId) {
                throw new HttpError(
                    402,
                    "You have used all five free applications this month",
                    {
                        code: "PAYMENT_REQUIRED",
                        limit: FREE_APPLICATION_LIMIT,
                        month: monthKey,
                        fee: APPLICATION_FEE_BDT,
                        currency: "BDT",
                    }
                )
            }

            const paymentObjectId = new ObjectId(paymentId)

            // A payment can be used once, for the same user, job and month only.
            const paymentResult = await applicationPayments.updateOne(
                {
                    _id: paymentObjectId,
                    userId,
                    jobId,
                    monthKey,
                    status: "succeeded",
                    usedAt: null,
                },
                { $set: { usedAt: new Date() } }
            )

            if (paymentResult.modifiedCount !== 1) {
                throw new HttpError(
                    400,
                    "Payment is invalid, already used, or expired"
                )
            }

            consumedPaymentId = paymentObjectId
            paymentMethod = "demo"

            await applicationUsage.updateOne(
                { userId, monthKey },
                { $inc: { count: 1 } }
            )
            usageIncremented = true
        }

        const newApplication = {
            jobId,
            userId,
            email,
            jobTitle: job.title,
            companyName: job.company,
            status: "pending",
            paymentId: consumedPaymentId?.toString() || null,
            paymentMethod,
            appliedAt: new Date(),
        }

        const result = await applications.insertOne(newApplication)

        res.status(201).json({
            success: true,
            message: "Application submitted successfully",
            insertedId: result.insertedId,
            paymentMethod,
        })
    } catch (error) {
        // Undo the monthly counter/payment reservation if inserting fails.
        if (usageIncremented) {
            await applicationUsage.updateOne(
                { userId, monthKey, count: { $gt: 0 } },
                { $inc: { count: -1 } }
            )
        }

        if (consumedPaymentId) {
            await applicationPayments.updateOne(
                { _id: consumedPaymentId },
                { $unset: { usedAt: "" } }
            )
        }

        throw error
    }
})

app.post("/applications", submitApplication)
app.post("/applications/apply", submitApplication)

// -----------------------------------------------------------------------------
// APPLICATION CHECK / WITHDRAW / SEEKER / RECRUITER
// -----------------------------------------------------------------------------

app.get(
    "/applications/check",
    asyncHandler(async (req, res) => {
        const { jobId, userId } = req.query

        if (!jobId || !userId) {
            throw new HttpError(400, "Job ID and user ID are required")
        }

        const application = await applications.findOne({ jobId, userId })

        res.status(200).json({
            success: true,
            hasApplied: Boolean(application),
        })
    })
)

app.delete(
    "/applications",
    asyncHandler(async (req, res) => {
        const { jobId, userId } = req.body

        if (!jobId || !userId) {
            throw new HttpError(400, "Job ID and user ID are required")
        }

        const result = await applications.deleteOne({ jobId, userId })

        if (!result.deletedCount) {
            throw new HttpError(404, "Application not found")
        }

        // Deliberately do not decrement monthly usage when withdrawing.
        // A submitted application still consumes that month's allowance.

        res.status(200).json({
            success: true,
            message: "Application withdrawn successfully",
        })
    })
)

app.get(
    "/applications/seeker/:userId",
    asyncHandler(async (req, res) => {
        const { userId } = req.params
        if (!userId) throw new HttpError(400, "User ID is required")

        const seekerApplications = await applications
            .find({ userId })
            .sort({ appliedAt: -1 })
            .toArray()

        const enrichedApplications = await Promise.all(
            seekerApplications.map(async (application) => {
                const job = isValidId(application.jobId)
                    ? await jobs.findOne({ _id: new ObjectId(application.jobId) })
                    : null

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
    })
)

app.get(
    "/applications/job/:jobId",
    asyncHandler(async (req, res) => {
        const { jobId } = req.params
        const { recruiterId } = req.query

        if (!isValidId(jobId)) throw new HttpError(400, "Invalid job ID")
        if (typeof recruiterId !== "string" || !recruiterId) {
            throw new HttpError(400, "Recruiter ID is required")
        }

        const job = await jobs.findOne({ _id: new ObjectId(jobId) })
        if (!job) throw new HttpError(404, "Job not found")

        if (job.recruiterId !== recruiterId) {
            throw new HttpError(403, "You are not authorized to view these applicants")
        }

        const jobApplications = await applications
            .find({ jobId })
            .sort({ appliedAt: -1 })
            .toArray()

        const enrichedApplicants = await Promise.all(
            jobApplications.map(async (application) => {
                const applicant = await users.findOne({ email: application.email })

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
    })
)

// -----------------------------------------------------------------------------
// ROOT + CENTRAL ERROR HANDLER
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
    res.send("Hire Loop is looping!")
})

// Express error middleware: one place handles errors from async routes.
app.use((error, req, res, next) => {
    console.error(`${req.method} ${req.originalUrl}:`, error)

    if (res.headersSent) return next(error)

    if (error.code === 11000) {
        return res.status(409).json({
            success: false,
            message: "You have already applied for this job",
        })
    }

    const status = error.status || 500

    res.status(status).json({
        success: false,
        message: error.message || "Internal server error",
        ...error.extra,
    })
})

// Connect, create indexes, then start listening.
const startServer = async () => {
    await client.connect()
    console.log("Successfully connected to MongoDB")

    await createIndexes()
    console.log("MongoDB indexes are ready")

    app.listen(port, () => {
        console.log(`HireLoop is listening on port ${port}`)
    })
}

startServer().catch((error) => {
    console.error("Failed to start HireLoop server:", error)
    process.exit(1)
})
