import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import { mapExport } from "@/server/work/decisions";

/** JSON export of the map (areas → projects → items with rollups and links). Export only; import is #153. */
export const GET = api(
  ({ user }) => {
    const data = mapExport(user);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="jarvis-map-${data.exportedAt.slice(0, 10)}.json"`,
        "cache-control": "no-store",
      },
    });
  },
  { cap: "work.use" },
);
