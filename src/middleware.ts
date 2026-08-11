import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "grassfed_session";
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET || "grassfed-sales-default-secret-change-me");

// Routes that don't require auth
const PUBLIC_ROUTES = ["/login", "/api/auth"];
// Webhook/cron routes — authenticated by external secrets, not user session
const SYSTEM_ROUTES = [
  "/api/webhooks/",
  "/api/sync/",
  "/api/slack/",
  "/api/debug",
  "/api/setup",
  "/api/seed",
  "/api/credits/award",
  "/api/blasts/process",
  "/api/confirmations/t1",
  "/api/confirmations/dayof",
];

// Role-based route access
// admin (isAdmin) can access everything
// Routes not listed here are accessible to any authenticated user
const ROLE_ROUTES: Record<string, string[]> = {
  setter: ["/", "/demos", "/verify", "/scoreboard", "/blasts", "/api/demos", "/api/verify", "/api/scoreboard", "/api/credits", "/api/blasts"],
  closer: ["/", "/demos", "/deals", "/scoreboard", "/api/demos", "/api/deals", "/api/scoreboard", "/api/kpis"],
  show_rate_rep: ["/", "/scoreboard", "/demos", "/confirmations", "/api/scoreboard", "/api/demos", "/api/kpis", "/api/confirmations"],
};

// Default landing page per role (when they hit "/")
const ROLE_DEFAULT: Record<string, string> = {
  setter: "/demos",
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_ROUTES.some(r => pathname.startsWith(r))) {
    return NextResponse.next();
  }

  // Allow system routes (webhooks, crons, syncs)
  if (SYSTEM_ROUTES.some(r => pathname.startsWith(r))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname.includes(".")) {
    return NextResponse.next();
  }

  // Check for session
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    // API routes return 401, page routes redirect to login
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // Verify JWT
  try {
    const { payload } = await jwtVerify(token, SECRET);
    const role = payload.role as string;
    const isAdmin = payload.isAdmin as boolean;

    // Admins can access everything
    if (isAdmin) {
      return NextResponse.next();
    }

    // Redirect "/" to role-specific default page
    if (pathname === "/" && ROLE_DEFAULT[role]) {
      return NextResponse.redirect(new URL(ROLE_DEFAULT[role], request.url));
    }

    // Check role-based access
    const allowedRoutes = ROLE_ROUTES[role];
    if (allowedRoutes) {
      const hasAccess = allowedRoutes.some(r => pathname === r || pathname.startsWith(r + "/") || pathname.startsWith(r + "?"));
      // Also allow /api/team (read-only for dropdowns) and /api/weeks
      const alwaysAllowed = ["/api/team", "/api/weeks"];
      const isAlwaysAllowed = alwaysAllowed.some(r => pathname.startsWith(r));

      if (!hasAccess && !isAlwaysAllowed) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
        // Redirect non-admin to their default page
        return NextResponse.redirect(new URL("/", request.url));
      }
    }

    return NextResponse.next();
  } catch {
    // Invalid token — clear it and redirect
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json({ error: "Invalid session" }, { status: 401 });
      res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
      return res;
    }
    const loginUrl = new URL("/login", request.url);
    const res = NextResponse.redirect(loginUrl);
    res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }
}

export const config = {
  matcher: [
    // Match all routes except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
