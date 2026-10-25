import { NextResponse, type NextRequest } from "next/server";

/**
 * Fallback for the POST share target when the service worker isn't controlling
 * the page (first launch): never reads the body, never mutates state.
 */
export function POST(req: NextRequest) {
  return NextResponse.redirect(new URL("/share?error=sw", req.nextUrl.origin), 303);
}
