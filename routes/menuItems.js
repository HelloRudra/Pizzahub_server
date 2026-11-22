import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import {
  CATEGORIES, FREE_LIMIT, wrap, isValidId, isPremium, escapeRegex, attachVendors,
} from '../utils.js';

const router = Router();
const items = () => getDB().collection('menuItems');

function validateItem(b) {
  const itemName = String(b.itemName || '').trim();
  const category = String(b.category || '');
  const description = String(b.description || '').trim();
  const location = String(b.location || '').trim();
  const price = Number(b.price);
  const images = Array.isArray(b.images)
    ? b.images.filter((u) => typeof u === 'string' && u.startsWith('http'))
    : [];

  if (itemName.length < 2) return { error: 'Item name is required' };
  if (!CATEGORIES.includes(category)) return { error: 'Invalid category' };
  if (description.length < 10) return { error: 'Description must be at least 10 characters' };
  if (!location) return { error: 'Location is required' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'Price must be greater than 0' };
  if (images.length === 0) return { error: 'At least one image is required' };

  return { data: { itemName, category, description, location, price, images } };
}

async function activeCount(vendorId) {
  return items().countDocuments({ vendorId, status: { $in: ['pending', 'approved'] } });
}

/* ---------- PUBLIC ---------- */

// Browse: search, filter, sort, pagination (approved items only)
router.get('/', wrap(async (req, res) => {
  const { search, category, location, sort } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);

  const filter = { status: 'approved' };
  if (search) filter.itemName = { $regex: escapeRegex(search), $options: 'i' };
  if (category) filter.category = category;
  if (location) filter.location = { $regex: escapeRegex(location), $options: 'i' };

  const sortMap = {
    price_asc: { price: 1, _id: 1 },
    price_desc: { price: -1, _id: 1 },
  };
  const sortBy = sortMap[sort] || { createdAt: -1 };

  const total = await items().countDocuments(filter);
  const list = await items().find(filter).sort(sortBy).skip((page - 1) * limit).limit(limit).toArray();

  res.json({
    items: await attachVendors(list),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
}));

// Home page: premium vendors' items first
router.get('/featured', wrap(async (req, res) => {
  const list = await items().find({ status: 'approved' }).sort({ createdAt: -1 }).limit(60).toArray();
  const withVendors = await attachVendors(list);
  withVendors.sort((a, b) => Number(b.vendor?.isPremium || false) - Number(a.vendor?.isPremium || false));
  res.json({ items: withVendors.slice(0, 6) });
}));

/* ---------- VENDOR ---------- */

router.get('/mine', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  const list = await items().find({ vendorId: req.user.id }).sort({ createdAt: -1 }).toArray();
  res.json({ items: list });
}));

router.post('/', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  const { error, data } = validateItem(req.body);
  if (error) return res.status(400).json({ message: error });

  if (!isPremium(req.user) && (await activeCount(req.user.id)) >= FREE_LIMIT) {
    return res.status(403).json({
      message: `Free plan allows only ${FREE_LIMIT} active items. Upgrade to Premium for unlimited items.`,
    });
  }

  const doc = { ...data, vendorId: req.user.id, status: 'pending', createdAt: new Date() };
  const result = await items().insertOne(doc);
  res.status(201).json({ message: 'Item submitted for approval', id: result.insertedId });
}));

// Single item for the owner (edit page)
router.get('/mine/:id', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const item = await items().findOne({ _id: new ObjectId(req.params.id) });
  if (!item) return res.status(404).json({ message: 'Item not found' });
  if (item.vendorId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
  res.json({ item });
}));

router.patch('/:id', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const item = await items().findOne({ _id: new ObjectId(req.params.id) });
  if (!item) return res.status(404).json({ message: 'Item not found' });
  if (item.vendorId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  const { error, data } = validateItem(req.body);
  if (error) return res.status(400).json({ message: error });

  await items().updateOne({ _id: item._id }, { $set: data }); // status can't be changed here
  res.json({ message: 'Item updated' });
}));

// Availability: approved <-> inactive
router.patch('/:id/availability', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const item = await items().findOne({ _id: new ObjectId(req.params.id) });
  if (!item) return res.status(404).json({ message: 'Item not found' });
  if (item.vendorId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  if (!['approved', 'inactive'].includes(item.status)) {
    return res.status(400).json({ message: 'Only approved items can be switched on or off' });
  }

  const makeActive = Boolean(req.body.active);
  if (makeActive && item.status === 'inactive' && !isPremium(req.user)
      && (await activeCount(req.user.id)) >= FREE_LIMIT) {
    return res.status(403).json({ message: 'Free plan limit reached. Upgrade to Premium.' });
  }

  const status = makeActive ? 'approved' : 'inactive';
  await items().updateOne({ _id: item._id }, { $set: { status } });
  res.json({ message: `Item is now ${status}`, status });
}));

router.delete('/:id', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const item = await items().findOne({ _id: new ObjectId(req.params.id) });
  if (!item) return res.status(404).json({ message: 'Item not found' });
  if (item.vendorId !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
  await items().deleteOne({ _id: item._id });
  res.json({ message: 'Item deleted' });
}));

/* ---------- ADMIN ---------- */

router.get('/admin/all', verifyToken, requireRole('admin'), wrap(async (req, res) => {
  const { search, status } = req.query;
  const filter = {};
  if (search) filter.itemName = { $regex: escapeRegex(search), $options: 'i' };
  if (status) filter.status = status;
  const list = await items().find(filter).sort({ createdAt: -1 }).toArray();
  res.json({ items: await attachVendors(list) });
}));

router.patch('/admin/:id/status', verifyToken, requireRole('admin'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected', 'inactive'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }
  const result = await items().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  if (!result.matchedCount) return res.status(404).json({ message: 'Item not found' });
  res.json({ message: `Item ${status}` });
}));

router.delete('/admin/:id', verifyToken, requireRole('admin'), wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const result = await items().deleteOne({ _id: new ObjectId(req.params.id) });
  if (!result.deletedCount) return res.status(404).json({ message: 'Item not found' });
  res.json({ message: 'Item deleted' });
}));

/* ---------- PUBLIC DETAILS (must stay last) ---------- */

router.get('/:id', wrap(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: 'Invalid item ID' });
  const item = await items().findOne({ _id: new ObjectId(req.params.id), status: 'approved' });
  if (!item) return res.status(404).json({ message: 'Item not found or not available' });
  const [withVendor] = await attachVendors([item]);
  res.json({ item: withVendor });
}));

export default router;