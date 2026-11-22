import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { wrap, isValidId } from '../utils.js';

const router = Router();
const orders = () => getDB().collection('orders');

// Adds item, vendor and customer info to each order
async function enrich(list) {
  const db = getDB();
  const toIds = (arr) => [...new Set(arr)].filter(isValidId).map((id) => new ObjectId(id));
  const [items, users] = await Promise.all([
    db.collection('menuItems').find({ _id: { $in: toIds(list.map((o) => o.itemId)) } }).toArray(),
    db.collection('users').find({ _id: { $in: toIds(list.flatMap((o) => [o.vendorId, o.customerId])) } }).toArray(),
  ]);
  const itemMap = new Map(items.map((i) => [i._id.toString(), i]));
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const pub = (u) =>
    u ? { id: u._id.toString(), name: u.name, email: u.email, image: u.image || null, businessName: u.businessName || null } : null;

  return list.map((o) => {
    const i = itemMap.get(o.itemId);
    return {
      ...o,
      item: i ? { itemName: i.itemName, images: i.images, price: i.price, category: i.category, location: i.location } : null,
      vendor: pub(userMap.get(o.vendorId)),
      customer: pub(userMap.get(o.customerId)),
    };
  });
}

/* ---------- CUSTOMER ---------- */

router.post('/', verifyToken, requireRole('customer'), wrap(async (req, res) => {
  const itemId = String(req.body.itemId || '');
  const deliveryDate = String(req.body.deliveryDate || '');
  const deliveryAddress = String(req.body.deliveryAddress || '').trim();
  const message = String(req.body.message || '').trim().slice(0, 500);

  if (!isValidId(itemId)) return res.status(400).json({ message: 'Invalid item ID' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || Number.isNaN(new Date(deliveryDate).getTime())) {
    return res.status(400).json({ message: 'Please choose a valid delivery date' });
  }
  const earliest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (deliveryDate < earliest) {
    return res.status(400).json({ message: 'Delivery date cannot be in the past' });
  }
  if (deliveryAddress.length < 5) {
    return res.status(400).json({ message: 'Please enter a full delivery address' });
  }

  const item = await getDB().collection('menuItems').findOne({ _id: new ObjectId(itemId), status: 'approved' });
  if (!item) return res.status(404).json({ message: 'This item is not available for ordering' });
  if (item.vendorId === req.user.id) {
    return res.status(403).json({ message: 'You cannot order your own item' });
  }

  const duplicate = await orders().findOne({
    itemId,
    customerId: req.user.id,
    deliveryDate,
    status: { $in: ['pending', 'accepted'] },
  });
  if (duplicate) {
    return res.status(409).json({ message: 'You already have an active order for this item on that date' });
  }

  const result = await orders().insertOne({
    itemId,
    vendorId: item.vendorId,
    customerId: req.user.id,
    deliveryDate,
    deliveryAddress,
    message,
    status: 'pending',
    createdAt: new Date(),
  });
  res.status(201).json({ message: 'Order placed successfully!', id: result.insertedId });
}));

router.get('/mine', verifyToken, requireRole('customer'), wrap(async (req, res) => {
  const list = await orders().find({ customerId: req.user.id }).sort({ createdAt: -1 }).toArray();
  res.json({ orders: await enrich(list) });
}));

router.patch('/:id/cancel', verifyToken, requireRole('customer'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid order ID' });
  const order = await orders().findOne({ _id: new ObjectId(req.params.id) });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.customerId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  const result = await orders().updateOne(
    { _id: order._id, status: 'pending' },
    { $set: { status: 'cancelled' } }
  );
  if (!result.modifiedCount) {
    return res.status(409).json({ message: `Only pending orders can be cancelled (this one is ${order.status})` });
  }
  res.json({ message: 'Order cancelled' });
}));

/* ---------- VENDOR ---------- */

router.get('/vendor', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  const list = await orders().find({ vendorId: req.user.id }).sort({ createdAt: -1 }).toArray();
  res.json({ orders: await enrich(list) });
}));

router.patch('/:id/status', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid order ID' });
  const { status } = req.body;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'Status must be accepted or rejected' });
  }
  const order = await orders().findOne({ _id: new ObjectId(req.params.id) });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.vendorId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  // The status: 'pending' filter makes sure an order can only be decided once
  const result = await orders().updateOne({ _id: order._id, status: 'pending' }, { $set: { status } });
  if (!result.modifiedCount) {
    return res.status(409).json({ message: `This order is already ${order.status}` });
  }
  res.json({ message: `Order ${status}` });
}));

/* ---------- STATS (vendor and customer overview) ---------- */

router.get('/stats', verifyToken, requireRole('vendor', 'customer'), wrap(async (req, res) => {
  const field = req.user.role === 'vendor' ? 'vendorId' : 'customerId';
  const rows = await orders()
    .aggregate([{ $match: { [field]: req.user.id } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
    .toArray();
  const stats = { total: 0, pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
  for (const r of rows) {
    stats[r._id] = r.count;
    stats.total += r.count;
  }
  res.json({ stats });
}));

export default router;