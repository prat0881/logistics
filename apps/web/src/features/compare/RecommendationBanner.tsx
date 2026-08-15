import { Sparkles } from "lucide-react";
import type { OfferDto, RecommendationDto } from "@svyft/shared";

export interface RecommendationBannerProps {
  recommendation: RecommendationDto | null;
  offers: OfferDto[];
}

/**
 * RecommendationBanner — names the engine's recommended (FF × variant) offer and its plain-English
 * reason (S5.6 §7/§12; `recommendation.reason` already reads like "High priority → fastest transit
 * (3 days); price broke the tie."). `RecommendationDto` itself carries no FF name, so the matching
 * `OfferDto` is looked up by `(quoteId, variant)` to label it — renders nothing when there's no
 * recommendation (no priced/QUOTED offers to recommend yet) or the referenced offer can't be
 * found on this leg (defensive; should not happen with a consistent read model).
 */
export function RecommendationBanner({ recommendation, offers }: RecommendationBannerProps) {
  if (!recommendation) return null;

  const offer = offers.find(
    (o) => o.quoteId === recommendation.quoteId && o.variant === recommendation.variant,
  );
  if (!offer) return null;

  return (
    <div
      data-testid="recommendation-banner"
      className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2"
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium text-foreground">
          Recommended:{" "}
          <span className="text-primary">
            {offer.freightForwarderName} — {offer.variantLabel}
          </span>
        </p>
        <p className="text-muted-foreground">{recommendation.reason}</p>
      </div>
    </div>
  );
}
