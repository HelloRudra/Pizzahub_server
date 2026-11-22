import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './db.js';
import { verifyToken } from './middleware/auth.js';

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// NOTE: the Stripe webhook route will need the raw body,
// so we'll register it BEFORE this line later.
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'PizzaHub API is running' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/api/me', verifyToken, (req, res) => {
  res.json({ user: req.user });
});

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('DB connection failed:', err.message);
    process.exit(1);
  });