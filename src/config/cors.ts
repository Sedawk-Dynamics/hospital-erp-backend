import { CorsOptions } from 'cors';

// Reflect the request origin and allow credentials. Credentials (cookies) are
// required by the PACS auth gateway (the OHIF iframe rides a cookie); the
// browser refuses to store cross-origin cookies under a wildcard origin, so we
// echo the specific origin instead of "*". Bearer-token auth is unaffected.
export const corsOptions: CorsOptions = {
  origin: true,
  credentials: true,
};