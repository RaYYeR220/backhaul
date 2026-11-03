/** A slide is drawn at 1280 × 720 CSS px: 13.33 × 7.5 in, one 16:9 page when printed. */
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

/**
 * Sets --deck-k, the scale that fits a whole slide in the window (or its width, on a phone), before
 * first paint and on every resize. Print ignores it.
 */
export const scaleScript = `(function(){var d=document.documentElement;function f(){var w=innerWidth,p=w<761,g=p?16:48,k=(w-2*g)/${SLIDE_W};if(!p)k=Math.min(k,(innerHeight-120)/${SLIDE_H});d.style.setProperty('--deck-k',String(Math.max(0.2,Math.min(k,2))))}f();addEventListener('resize',f)})()`;
