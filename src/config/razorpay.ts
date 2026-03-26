import Razorpay from 'razorpay';
import { env } from './env';

// Initialize Razorpay with keys from environment
// Uses test keys in development, production keys in production
export const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});
