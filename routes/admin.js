import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { wrap, isValidId, escapeRegex } from '../utils.js';

const router = Router();
router.use(verifyToken, requireRole('admin'));

const users = () => getDB().collection('users');

router.get('/stats', wrap(async (req, res) => {
  const db = getDB();
  const [totalUsers, vendors, customers, totalItems, pendingItems, totalTransactions, byStatus] =
    await Promise.all([
      users().countDocuments({}),
      users().countDocuments({ role: 'vendor' }),
      users().countDocuments({ role: 'customer' }),
      db.collection('menuItems').countDocuments({}),
      db.collection('menuItems').countDocuments({ status: 'pending' }),
      db.collection('transactions').countDocuments({}),
      db.collection('menuItems').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
    ]);
  res.json({
    stats: { totalUsers, vendors, customers, totalItems, pendingItems, totalTransactions },
    itemsByStatus: byStatus.map((s) => ({ status: s._id, count: s.count })),
  });
}));

router.get('/users', wrap(async (req, res) => {
  const { search, role } = req.query;
  const filter = {};
  if (role && ['vendor', 'customer', 'admin'].includes(role)) filter.role = role;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const list = await users().find(filter).sort({ createdAt: -1 }).toArray();
  res.json({
    users: list.map((u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      image: u.image || null,
      role: u.role,
      businessName: u.businessName || null,
      isBlocked: Boolean(u.isBlocked),
      subscriptionPlan: u.subscriptionPlan || 'free',
      subscriptionExpiresAt: u.subscriptionExpiresAt || null,
      createdAt: u.createdAt,
    })),
  });
}));

router.patch('/users/:id/block', wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID' });
  if (req.params.id === req.user.id) return res.status(400).json({ message: 'You cannot block yourself' });
  const user = await users().findOne({ _id: new ObjectId(req.params.id) });
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role === 'admin') return res.status(403).json({ message: 'Admins cannot be blocked' });

  const isBlocked = Boolean(req.body.isBlocked);
  await users().updateOne({ _id: user._id }, { $set: { isBlocked } });
  res.json({ message: isBlocked ? 'User blocked' : 'User unblocked' });
}));

// Read-only: there is intentionally no route to edit or delete transactions
router.get('/transactions', wrap(async (req, res) => {
  const list = await getDB().collection('transactions').find({}).sort({ createdAt: -1 }).toArray();
  const ids = [...new Set(list.map((t) => t.vendorId))].filter(isValidId).map((id) => new ObjectId(id));
  const vendors = await users().find({ _id: { $in: ids } }).toArray();
  const map = new Map(vendors.map((v) => [v._id.toString(), v]));
  res.json({
    transactions: list.map((t) => {
      const v = map.get(t.vendorId);
      return {
        ...t,
        vendor: v ? { name: v.name, email: v.email, businessName: v.businessName || null } : null,
      };
    }),
  });
}));

export default router;