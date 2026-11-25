import { resultText, stepsText, type SearchResult, type SearchStep } from "../terrain/mostPieces";

/**
 * Under "As many pieces as will print well": the sizes tried while it looks, then the size found, how many pieces that
 * makes and why it can't be smaller.
 */
export function MostPiecesNote({ search, noun, pieces, floorWords, what }: { search: { steps: SearchStep[]; result: SearchResult | null } | null; noun: string; pieces: number | null; floorWords: string; what: string }) {
  if (!search) return <p className="muted small">The size is worked out once the heights are in.</p>;
  const { steps, result } = search;
  if (!result)
    return (
      <p className="muted small" aria-live="polite">
        Finding the smallest {what} that print well… {stepsText(steps)}
      </p>
    );
  if (result.size === null) return <p className="mountain-warn small">{resultText(result, floorWords)}</p>;
  return (
    <p className="muted small" aria-live="polite">
      <strong>
        {noun}: {+result.size.toFixed(1)} mm (smallest that prints well){pieces !== null ? ` — ${pieces} pieces` : ""}.
      </strong>{" "}
      {resultText(result, floorWords)} <span title="Sizes tried">({stepsText(result.steps)})</span>
    </p>
  );
}
