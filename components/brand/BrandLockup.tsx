import { BRAND_NAME } from "@/lib/brand";
import { AtlasMark } from "./AtlasMark";

/** Compact wordmark, inherited text colour. Do not add the long expansion to chrome. */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`atlas-lockup ${className}`}>
      <AtlasMark className="atlas-lockup-mark" />
      <span>{BRAND_NAME}</span>
    </span>
  );
}
