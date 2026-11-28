import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { wrap, isValidId, attachVendors } from '../utils.js';

const router = Router();
router.use(verifyToken, requireRole('customer'));
const users = () => getDB().collection('users');

router.get('/', wrap(async (req, res) => {
  const u = await users().findOne({ _id: new ObjectId(req.user.id) });
  const ids = (u?.favorites || []).filter(isValidId);
  const list = await getDB()
    .collection('menuItems')
    .find({ _id: { $in: ids.map((i) => new ObjectId(i)) }, status: 'approved' })
    .toArray();
  res.json({ items: await attachVendors(list), ids });
}));

router.post('/:itemId', wrap(async (req, res) => {
  const { itemId } = req.params;
  if (!isValidId(itemId)) return res.status(400).json({ message: 'Invalid item ID' });

  const u = await users().findOne({ _id: new ObjectId(req.user.id) });
  const has = (u?.favorites || []).includes(itemId);

  if (!has) {
    const item = await getDB().collection('menuItems').findOne({ _id: new ObjectId(itemId), status: 'approved' });
    if (!item) return res.status(404).json({ message: 'Item not available' });
  }
  await users().updateOne(
    { _id: u._id },
    has ? { $pull: { favorites: itemId } } : { $addToSet: { favorites: itemId } }
  );
  res.json({ favorited: !has, message: has ? 'Removed from favorites' : 'Added to favorites' });
}));

export default router;