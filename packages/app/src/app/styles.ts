/** App stylesheet, built on the design's .tka (dark) / .tkl (light) token sets. */
export const APP_CSS = `
:root.tka{--pg:#14100E;--card:#1C1512;--tx:#F5F0E8;--sec:#A79E94;--mut:#8A8279;--hl:#2A221D;--btn:#F5F0E8;--btnTx:#1A140F;--amb:#E8940C;--ok:#6FE3A1;--warnBg:#3A2F10;--calmBg:#1E2A22}
:root.tkl{--pg:#FFFFFF;--card:#F7F5F2;--tx:#1C1512;--sec:#55504C;--mut:#756D63;--hl:#E3DED7;--btn:#1C1512;--btnTx:#FFFFFF;--amb:#A05E00;--ok:#0B7A46;--warnBg:#FBF0D8;--calmBg:#EAF3EC}
*{box-sizing:border-box}
body{margin:0;background:var(--pg);color:var(--tx);font-family:Mulish,system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.wrap{max-width:460px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column;padding:calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
.wrap>.actions{margin-top:auto;padding-top:18px}
.entry-body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:2px}
.mark{font:900 30px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;color:var(--amb);margin-bottom:16px}
.entry-h{font-size:26px;font-weight:900;letter-spacing:-0.02em;line-height:1.2;margin:0 0 8px}
.entry-s{color:var(--sec);font-size:14.5px;line-height:1.55;font-weight:600;margin:0 0 22px}
.entry .btn{margin-top:10px}
.tab-row{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:48px;background:none;border:none;border-top:1px solid var(--hl);color:var(--tx);font-size:14px;font-weight:800;text-align:left}
.hdr{display:flex;align-items:center;gap:10px;padding:6px 2px 16px}
.brand{font-size:17px;font-weight:900;letter-spacing:-0.01em}
.chip{font:800 10px ui-monospace,Menlo,monospace;padding:3px 8px;border-radius:99px;background:var(--amb);color:#14100E;letter-spacing:.04em}
.tog{margin-left:auto;background:none;border:1px solid var(--hl);color:var(--sec);border-radius:99px;min-width:40px;height:32px;font-weight:700}
.hero{background:var(--card);border-radius:16px;padding:26px 20px;text-align:center}
.pos{font-size:44px;font-weight:900;letter-spacing:-0.03em;line-height:1}
.unit{font-size:16px;color:var(--sec);font-weight:800}
.sub{color:var(--sec);font-size:13px;font-weight:700;margin-top:6px}
.card,.round{background:var(--card);border-radius:16px;padding:16px;margin-top:12px}
.collapse-h,.round-h{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
.collapse-h strong,.round-h strong{font-size:14px;font-weight:900}
.dim{color:var(--mut);font-weight:700;font-size:12px}
.dim.sm{font-size:11.5px}
.collapse-n{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 0 14px;font-size:13px;color:var(--sec);font-weight:700}
.big{font-size:26px;font-weight:900;color:var(--tx)}
.big.amb{color:var(--amb)}
.arrow{color:var(--mut);font-size:18px}
.leg{display:flex;align-items:center;gap:8px;min-height:48px;border-top:1px solid var(--hl);flex-wrap:wrap}
.leg-w{flex:1;font-size:13.5px;font-weight:800;min-width:120px}
.leg-a{font-size:14px;font-weight:900}
.leg-s{width:100%;font-size:11.5px;font-weight:700;color:var(--mut)}
.leg.landed .leg-s{color:var(--ok)}
.leg.sending .leg-s{color:var(--amb)}
.nudge{background:none;border:1px solid var(--hl);color:var(--sec);border-radius:99px;padding:5px 12px;font-weight:800;font-size:11.5px;min-height:32px}
.expiry{margin-left:auto;font-size:11.5px;font-weight:800;color:var(--mut)}
.expiry.warn{color:var(--amb)}
.note{margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--mut);font-weight:600}
.note.ok{color:var(--ok)}
.req{border-top:1px solid var(--hl);padding:12px 0 4px}
.req-t{font-size:14px;font-weight:800}
.req-a{display:flex;gap:8px;margin:10px 0 6px}
.btn{width:100%;min-height:48px;border-radius:12px;background:var(--btn);color:var(--btnTx);font-weight:800;font-size:15px;border:none;margin-top:12px}
.btn.sm{min-height:40px;margin:0;flex:1;font-size:14px}
.btn.ghost{background:none;border:1px solid var(--hl);color:var(--sec)}
.actions{margin-top:14px}
.banner{border-radius:12px;padding:12px 14px;margin-bottom:12px}
.banner.calm{background:var(--calmBg)}
.banner.warn{background:var(--warnBg)}
.banner-t{font-size:13.5px;font-weight:900}
.banner-b{font-size:12.5px;line-height:1.55;color:var(--sec);font-weight:600;margin-top:3px}
.banner-a{margin-top:8px;background:none;border:1px solid var(--hl);color:var(--tx);border-radius:99px;padding:7px 14px;font-weight:800;font-size:12px;min-height:34px}
.rec{border-top:1px solid var(--hl);padding:10px 0}
.rec-h{display:flex;justify-content:space-between;font-size:13px;font-weight:800}
.rec.ok .rec-h span{color:var(--ok)}
.rec.bad .rec-h span{color:var(--amb)}
.rec.pending .rec-h span{color:var(--mut)}
.mono{font:500 11.5px ui-monospace,Menlo,monospace;color:var(--mut);margin-top:4px}
button{cursor:pointer;font-family:inherit}
`;
