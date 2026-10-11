import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only endpoint the app uses to save prop sizes back into src/packs/<pack>/pack.json, so tweaks
 * made while looking at the map stick. The write doesn't reload the page (the app already applied it).
 */
function packEditor(): Plugin {
  const written = new Map<string, number>();
  return {
    name: 'wmb-pack-editor',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__wmb/foot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const { pack, id, foot } = JSON.parse(body);
            if (typeof pack !== 'string' || !/^[a-z0-9-]+$/.test(pack)) throw new Error('bad pack');
            const ok = (v: unknown) => typeof v === 'number' && v > 0 && v <= 8;
            if (!(ok(foot) || (Array.isArray(foot) && foot.length === 2 && foot.every(ok)))) throw new Error('bad size');
            const file = path.resolve(server.config.root, 'src/packs', pack, 'pack.json');
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            const prop = json.props?.find((p: { id: string }) => p.id === id);
            if (!prop) throw new Error('no such prop');
            prop.foot = foot;
            written.set(file, Date.now());
            // keep [x, y] sizes on one line, like the rest of the file is written by hand
            const text = JSON.stringify(json, null, 2).replace(/\[\s*([\d.]+),\s*([\d.]+)\s*\]/g, '[$1, $2]');
            fs.writeFileSync(file, text + '\n');
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
    hotUpdate({ file }) {
      // our own write: the module is invalidated for the next load, but don't reload the page now
      const t = written.get(path.resolve(file));
      if (t && Date.now() - t < 3000) return [];
    },
  };
}

export default defineConfig({
  plugins: [packEditor()],
});
