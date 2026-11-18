import type { Theme } from "@/db/schema";
import { themeRunnable, PRODUCT_LABEL } from "@/lib/themes";
import { ART_PRODUCTS } from "@/lib/brain/product-origin";
export function PipelineFields({ themes, themeId, phrase, legend, product = "wall-art", direction = "" }: { themes: Theme[]; themeId?: string | null; phrase: string; legend: string; product?: string; direction?: string }) {
  const runnable = themes.filter(themeRunnable);
  return (
    <fieldset className="pipe">
      <legend>{legend}</legend>
      <div className="pipe-row">
        <select name="theme" defaultValue={themeId && runnable.some((t) => t.id === themeId) ? themeId : runnable[0]?.id} aria-label="Theme">
          {runnable.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input name="phrase" defaultValue={phrase} maxLength={80} aria-label="Primary buyer phrase" placeholder="Primary buyer phrase" />
      </div>
      <select name="product" defaultValue={product} aria-label="Product to create">{ART_PRODUCTS.map(p => <option key={p} value={p}>{PRODUCT_LABEL[p]}</option>)}</select>
      <textarea name="direction" defaultValue={direction} minLength={30} maxLength={1600} aria-label="Your original product direction" placeholder="Describe your original subject, composition, palette and buyer use. Do not copy a reel frame, brand, slogan or creator artwork." />
      <label className="pipe-ok"><input type="checkbox" name="confirm" /><span>I confirm this buyer phrase and original product direction. I will check originality before publishing. Approving creates a keyword and design brief. The design uses the existing daily AI budget, then must pass the quality gate and wait in the approval queue. Nothing publishes on its own.</span></label>
    </fieldset>
  );
}
