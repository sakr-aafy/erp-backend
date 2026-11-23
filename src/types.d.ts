import type { Types } from 'mongoose';

export interface AuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
  name: string;
  email: string;
  roleId: Types.ObjectId;
  roleName: string;
  permissions: Set<string>;
  isPlatformAdmin: boolean;
}
declare global {
  namespace Express {
    interface Request { auth?: AuthContext }
  }
}
