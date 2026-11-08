import express from "express";
import cors from 'cors'



const app = express();
const port = process.env.PORT || 8000;


// middleware
app.use(express.json())
app.use(cors())

app.get('/', (req, res) => {
    res.send('Hire Loop is looping!');
});

app.listen(port, () => {
    console.log(`Hireloop is listening on port ${port}`);
});