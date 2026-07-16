import "express";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        distributor_id: string;
        client_id: string;
      };
    }
  }
}

export {};
