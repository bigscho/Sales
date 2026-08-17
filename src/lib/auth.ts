import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SESSION_COOKIE = "grassfed_session";
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET || "grassfed-sales-default-secret-change-me");

export interface SessionPayload {
  memberId: string;
  name: string;
  role: string;
  accessRole?: string | null; // overrides `role` for nav/route access only
  isAdmin: boolean;
}

export async function createSession(payload: SessionPayload): Promise<string> {
  const token = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(SECRET);
  return token;
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return {
      memberId: payload.memberId as string,
      name: payload.name as string,
      role: payload.role as string,
      accessRole: (payload.accessRole as string | undefined) ?? null,
      isAdmin: payload.isAdmin as boolean,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export { SESSION_COOKIE };
