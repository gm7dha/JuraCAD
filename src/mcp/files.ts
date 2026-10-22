/**
 * The one folder the JuraCAD extension may use (chosen when it's installed,
 * normally Documents/JuraCAD). Every file name Claude gives is checked so
 * nothing outside that folder is ever read or written.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { InputError } from "./args";

export class DesignFolder {
  readonly root: string;

  constructor(root: string) {
    if (!root || !root.trim()) throw new Error("No folder for designs was given.");
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  /**
   * The full path for a file name in the folder, with the extension added if
   * it's missing. Only plain names are allowed: no folders, no "..".
   */
  pathFor(name: string, extensions: readonly string[], what = "file"): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new InputError(`Give a ${what} name, e.g. "bracket".`);
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("\0") || /^[a-z]:/i.test(trimmed)) {
      throw new InputError(`"${trimmed}" isn't a plain file name. Designs live in one folder (${this.root}); give just a name like "bracket", without any folder.`);
    }
    if (trimmed.startsWith(".")) throw new InputError(`"${trimmed}" starts with a dot (a hidden file). Give a normal name like "bracket".`);
    const lower = trimmed.toLowerCase();
    const known = extensions.find((e) => lower.endsWith(e));
    let file = trimmed;
    if (!known) {
      const other = /\.[a-z0-9]{2,5}$/i.exec(trimmed);
      if (other && !extensions.includes(other[0].toLowerCase()) && /^\.(stl|step|stp|3mf|json|txt|juracad|partsmith|png|svg)$/i.test(other[0])) {
        throw new InputError(`"${trimmed}" should end in ${extensions.join(" or ")} here.`);
      }
      file = trimmed + extensions[0];
    }
    if (basename(file) !== file || file.length > 200) throw new InputError(`"${trimmed}" isn't a usable file name. Try a shorter, plain name.`);
    const full = join(this.root, file);
    // A link inside the folder could point anywhere: never follow one.
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new InputError(`"${file}" is a shortcut (link) to somewhere else, so it can't be used. Choose another name.`);
    return full;
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  read(path: string): string {
    if (!existsSync(path)) {
      const names = this.list([".juracad", ".partsmith"]).map((f) => f.name);
      throw new InputError(`There's no file called "${basename(path)}" in ${this.root}.${names.length ? ` The designs there are: ${names.join(", ")}.` : " That folder has no designs yet."}`);
    }
    if (statSync(path).size > 50 * 1024 * 1024) throw new InputError(`"${basename(path)}" is too big to open here (over 50 MB).`);
    return readFileSync(path, "utf8");
  }

  /** Write via a temporary file, so a failed save never leaves half a design. */
  write(path: string, data: string | Uint8Array): void {
    const tmp = join(this.root, `.${basename(path)}.saving`);
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  list(extensions: readonly string[]): { name: string; bytes: number; modified: Date }[] {
    return readdirSync(this.root)
      .filter((n) => !n.startsWith(".") && extensions.some((e) => n.toLowerCase().endsWith(e)))
      .map((n) => {
        const st = lstatSync(join(this.root, n));
        return { name: n, bytes: st.size, modified: st.mtime, link: st.isSymbolicLink() };
      })
      .filter((f) => !f.link)
      .map(({ name, bytes, modified }) => ({ name, bytes, modified }))
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }
}
