import { ObjectId } from 'mongodb';
import { getDB } from './db.js';

export const CATEGORIES = [
  'Classic Pizzas',
  'Vegetarian Pizzas',
  'Meat Lovers',
  'Specialty / Gourmet Pizzas',
  'Sides & Appetizers',
  'Beverages & Desserts',
];

export const FREE_LIMIT = 3;

// Wraps async routes so errors reach the central error handler
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const isValidId = (id) =>
  typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

export const isPremium = (u) =>
  u?.subscriptionPlan === 'premium' &&
  (!u.subscriptionExpiresAt || new Date(u.subscriptionExpiresAt) > new Date());

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Adds vendor info (name, restaurant, premium badge) to each item
export async function attachVendors(items) {
  const ids = [...new Set(items.map((i) => i.vendorId))].filter(isValidId);
  const vendors = await getDB()
    .collection('users')
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .toArray();
  const map = new Map(vendors.map((v) => [v._id.toString(), v]));

  return items.map((item) => {
    const v = map.get(item.vendorId);
    return {
      ...item,
      vendor: v
        ? {
            id: v._id.toString(),
            name: v.name,
            businessName: v.businessName || v.name,
            image: v.image || null,
            isPremium: isPremium(v),
          }
        : null,
    };
  });
}