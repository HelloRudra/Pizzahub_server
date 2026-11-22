import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';

let JWKS;
function getJWKS() {
  if (!JWKS) {
    JWKS = createRemoteJWKSet(new URL(`${process.env.AUTH_URL}/api/auth/jwks`));
  }
  return JWKS;
}

// 1) Checks the token is valid, then loads the real user from the database
export async function verifyToken(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Unauthorized: token missing' });
  }

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: process.env.AUTH_URL,
    });
    const userId = payload.sub || payload.id;
    const users = getDB().collection('users');

    let user = null;
    if (ObjectId.isValid(userId)) {
      user = await users.findOne({ _id: new ObjectId(userId) });
    }
    if (!user) user = await users.findOne({ id: userId });

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized: user not found' });
    }
    if (user.isBlocked) {
      return res.status(403).json({ message: 'Your account has been blocked' });
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      businessName: user.businessName,
      subscriptionPlan: user.subscriptionPlan || 'free',
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    };
    next();
  } catch (err) {
    console.error('JWT error:', err.message);
    return res.status(401).json({ message: 'Unauthorized: invalid or expired token' });
  }
}

// 2) Allows only the listed roles, e.g. requireRole('admin')
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
    }
    next();
  };