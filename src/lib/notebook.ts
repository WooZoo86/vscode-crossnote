import * as fs from "fs";
import * as path from "path";
import YAML from "yamljs";
import { Note, NoteConfig, getHeaderFromMarkdown } from "./note";
import AES from "crypto-js/aes";
import mkdirp from "mkdirp";
import slash from "slash";
import { SelectedSection, CrossnoteSectionType } from "./section";
import { randomID } from "../util/util";

const pfs = fs.promises;

export interface Directory {
  name: string;
  path: string;
  children: Directory[];
}

export interface TagNode {
  name: string;
  path: string;
  children: TagNode[];
}

interface ListNotesArgs {
  dir: string;
  includeSubdirectories?: Boolean;
}

interface MatterOutput {
  data: any;
  content: string;
}

/**
 * Change "createdAt" to "created", and "modifiedAt" to "modified"
 * @param noteConfig
 */
function formatNoteConfig(noteConfig: NoteConfig) {
  const newObject: any = Object.assign({}, noteConfig);

  newObject["created"] = noteConfig.createdAt;
  delete newObject["createdAt"];

  newObject["modified"] = noteConfig.modifiedAt;
  delete newObject["modifiedAt"];

  return newObject;
}

export class Notebook {
  public name: string;
  public dir: string;
  public notes: Note[] = [];
  public rootDirectory: Directory | undefined;
  public rootTagNode: TagNode | undefined;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
  }

  // TODO: Change to use FileSystemWatcher
  // https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher
  public async initData() {
    this.notes = await this.listNotes({
      dir: "./",
      includeSubdirectories: true,
    });

    const res = await Promise.all([
      this.getNotebookDirectoriesFromNotes(this.notes),
      this.getNotebookTagNodeFromNotes(this.notes),
    ]);
    this.rootDirectory = res[0];
    this.rootTagNode = res[1];
  }

  public async refreshRootTagNode() {
    this.rootTagNode = await this.getNotebookTagNodeFromNotes(this.notes);
  }

  private matter(markdown: string): MatterOutput {
    let endFrontMatterOffset = 0;
    let frontMatter = {};
    if (
      markdown.startsWith("---") &&
      /* tslint:disable-next-line:no-conditional-assignment */
      (endFrontMatterOffset = markdown.indexOf("\n---")) > 0
    ) {
      const frontMatterString = markdown.slice(3, endFrontMatterOffset);
      try {
        frontMatter = YAML.parse(frontMatterString);
      } catch (error) {}
      markdown = markdown
        .slice(endFrontMatterOffset + 4)
        .replace(/^[ \t]*\n/, "");
    }
    return {
      data: frontMatter,
      content: markdown,
    };
  }

  private matterStringify(markdown: string, frontMatter: any) {
    frontMatter = frontMatter || {};
    const yamlStr = YAML.stringify(frontMatter).trim();
    if (yamlStr === "{}" || !yamlStr) {
      return markdown;
    } else {
      return `---
${yamlStr}
---
${markdown}`;
    }
  }

  public async getNote(
    filePath: string,
    stats?: fs.Stats
  ): Promise<Note | null> {
    const absFilePath = path.resolve(this.dir, filePath);
    if (!stats) {
      try {
        stats = await pfs.stat(absFilePath);
      } catch (error) {
        return null;
      }
    }
    if (stats.isFile() && filePath.endsWith(".md")) {
      let markdown = await pfs.readFile(absFilePath, { encoding: "utf-8" });
      // console.log("read: ", filePath, markdown);

      // Read the noteConfig, which is like <!-- note {...} --> at the end of the markdown file
      let noteConfig: NoteConfig = {
        // id: "",
        createdAt: new Date(stats.ctimeMs),
        modifiedAt: new Date(stats.mtimeMs),
        tags: [],
      };

      try {
        const data = this.matter(markdown);
        const frontMatter: any = Object.assign({}, data.data);

        if (data.data["note"]) {
          // Legacy note config
          noteConfig = Object.assign(noteConfig, data.data["note"] || {});
          delete frontMatter["note"];

          // Migration
          if (noteConfig.createdAt && noteConfig.modifiedAt) {
            const newFrontMatter = Object.assign(
              {},
              frontMatter,
              formatNoteConfig(noteConfig)
            );
            const newMarkdown = this.matterStringify(
              data.content,
              newFrontMatter
            );
            await pfs.writeFile(absFilePath, newMarkdown);
          }
        } else {
          // New note config design in beta 3
          if (data.data["created"]) {
            noteConfig.createdAt = new Date(data.data["created"]);
            delete frontMatter["created"];
          }
          if (data.data["modified"]) {
            noteConfig.modifiedAt = new Date(data.data["modified"]);
            delete frontMatter["modified"];
          }
          if (data.data["tags"]) {
            // TODO: Remove this tags support
            noteConfig.tags = data.data["tags"];
            delete frontMatter["tags"];
          }
          if (data.data["encryption"]) {
            // TODO: Remove the encryption support
            noteConfig.encryption = data.data["encryption"];
            delete frontMatter["encryption"];
          }
          if (data.data["pinned"]) {
            noteConfig.pinned = data.data["pinned"];
            delete frontMatter["pinned"];
          }
        }

        // markdown = matter.stringify(data.content, frontMatter); // <= NOTE: I think gray-matter has bug. Although I delete "note" section from front-matter, it still includes it.
        markdown = this.matterStringify(data.content, frontMatter);
      } catch (error) {
        // Do nothing
        markdown =
          "Please fix front-matter. (👈 Don't forget to delete this line)\n\n" +
          markdown;
      }

      // Create note
      const note: Note = {
        notebookPath: this.dir,
        filePath: slash(path.relative(this.dir, absFilePath)),
        markdown: markdown, // notFullMarkdown ? markdown.slice(0, 1000) : markdown, <= This will break the search
        config: noteConfig,
      };
      return note;
    } else {
      return null;
    }
  }

  public async listNotes({
    dir = "./",
    includeSubdirectories = true,
  }: ListNotesArgs): Promise<Note[]> {
    let notes: Note[] = [];
    let files: string[] = [];
    try {
      files = await pfs.readdir(path.resolve(this.dir, dir));
    } catch (error) {
      files = [];
    }
    const listNotesPromises = [];
    for (let i = 0; i < files.length; i++) {
      // TODO: Improve the performance here
      const file = files[i];
      const absFilePath = path.resolve(this.dir, dir, file);
      const stats = await pfs.stat(absFilePath);
      const note = await this.getNote(
        path.relative(this.dir, absFilePath),
        stats
      );
      if (note) {
        notes.push(note);
      }

      if (
        stats.isDirectory() &&
        !file.match(/^(\.git|node_modules)$/) && // TODO: More directories should be ignored. Should match .gitignore
        includeSubdirectories
      ) {
        listNotesPromises.push(
          this.listNotes({
            dir: path.relative(this.dir, absFilePath),
            includeSubdirectories,
          })
        );
      }
    }
    const res = await Promise.all(listNotesPromises);
    res.forEach((r) => {
      notes = notes.concat(r);
    });

    // console.log("listNotes: ", notes);
    return notes;
  }

  // public async moveNote(fromFilePath: string, toFilePath: string) {}
  public async getNotebookDirectoriesFromNotes(
    notes: Note[]
  ): Promise<Directory> {
    const rootDirectory: Directory = {
      name: ".",
      path: ".",
      children: [],
    };

    const filePaths = new Set<string>([]);
    for (let i = 0; i < notes.length; i++) {
      filePaths.add(path.dirname(notes[i].filePath));
    }

    filePaths.forEach((value) => {
      const dirNames = value.split("/");
      let directory = rootDirectory;
      for (let i = 0; i < dirNames.length; i++) {
        if (dirNames[i] === ".") {
          break;
        } else {
          let subDirectory = directory.children.filter(
            (directory) => directory.name === dirNames[i]
          )[0];
          if (subDirectory) {
            directory = subDirectory;
          } else {
            let paths: string[] = [];
            for (let j = 0; j <= i; j++) {
              paths.push(dirNames[j]);
            }
            subDirectory = {
              name: dirNames[i],
              path: paths.join("/"),
              children: [],
            };
            directory.children.push(subDirectory);
            directory = subDirectory;
          }
        }
      }
    });

    return rootDirectory;
  }

  public getNotebookTagNodeFromNotes(notes: Note[]): TagNode {
    const rootTagNode: TagNode = {
      name: ".",
      path: ".",
      children: [],
    };

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const tags = note.config.tags || [];
      tags.forEach((tag) => {
        let node = rootTagNode;
        tag.split("/").forEach((t) => {
          t = t.toLocaleLowerCase().replace(/\s+/g, " ");
          const offset = node.children.findIndex((c) => c.name === t);
          if (offset >= 0) {
            node = node.children[offset];
          } else {
            const newNode: TagNode = {
              name: t,
              path: node.name === "." ? t : node.path + "/" + t,
              children: [],
            };
            node.children.push(newNode);
            node.children.sort((x, y) => x.name.localeCompare(y.name));
            node = newNode;
          }
        });
      });
    }

    return rootTagNode;
  }

  public hasSummaryMD(): boolean {
    return fs.existsSync(path.resolve(this.dir, "SUMMARY.md"));
  }

  public async writeNote(
    filePath: string,
    markdown: string,
    noteConfig: NoteConfig,
    password?: string
  ): Promise<Note> {
    noteConfig.modifiedAt = new Date();
    noteConfig.createdAt = new Date(noteConfig.createdAt);
    let newNote: Note;
    try {
      const data = this.matter(markdown);
      if (data.data["note"] && data.data["note"] instanceof Object) {
        noteConfig = Object.assign({}, noteConfig, data.data["note"] || {});
      }
      const frontMatter = Object.assign(
        data.data || {},
        formatNoteConfig(noteConfig)
      );
      markdown = data.content;
      if (noteConfig.encryption) {
        // TODO: Refactor
        noteConfig.encryption.title = getHeaderFromMarkdown(markdown);
        markdown = AES.encrypt(
          JSON.stringify({ markdown }),
          password || ""
        ).toString();
      }
      newNote = {
        config: noteConfig,
        markdown: markdown, // <= The markdown here is actually wrong, but it doesn't matter
        notebookPath: this.dir,
        filePath: filePath,
      };
      markdown = this.matterStringify(markdown, frontMatter);
    } catch (error) {
      if (noteConfig.encryption) {
        // TODO: Refactor
        noteConfig.encryption.title = getHeaderFromMarkdown(markdown);
        markdown = AES.encrypt(
          JSON.stringify({ markdown }),
          password || ""
        ).toString();
      }
      newNote = {
        config: noteConfig,
        markdown: markdown,
        notebookPath: this.dir,
        filePath: filePath,
      };
      markdown = this.matterStringify(markdown, formatNoteConfig(noteConfig));
    }

    await pfs.writeFile(path.resolve(this.dir, filePath), markdown);
    return newNote;
  }

  public deleteNote(note: Note) {
    if (fs.existsSync(path.resolve(this.dir, note.filePath))) {
      fs.unlinkSync(path.resolve(this.dir, note.filePath));

      const index = this.notes.findIndex((n) => n.filePath === note.filePath);
      if (index >= 0) {
        this.notes.splice(index, 1);
      }
    }
  }

  public async changeNoteFilePath(note: Note, newFilePath: string) {
    newFilePath = newFilePath.replace(/^\/+/, "");
    if (!newFilePath.endsWith(".md")) {
      newFilePath = newFilePath + ".md";
    }

    const oldFilePath = note.filePath;
    const newDirPath = path.dirname(path.resolve(this.dir, newFilePath));
    await mkdirp(newDirPath);

    // TODO: Check if newFilePath already exists. If so don't overwrite
    const exists = fs.existsSync(path.resolve(this.dir, newFilePath));
    if (exists) {
      throw new Error("Target file already exists");
    }

    await pfs.rename(
      path.resolve(this.dir, oldFilePath),
      path.resolve(this.dir, newFilePath)
    );

    const oldNote = this.notes.find((n) => n.filePath === oldFilePath);
    if (oldNote) {
      oldNote.filePath = newFilePath;
    }
    return oldNote;
  }

  public async duplicateNote(filePath: string) {
    const oldNote = await this.getNote(filePath);
    if (!oldNote) {
      return null;
    }
    const noteConfig = oldNote.config;
    noteConfig.createdAt = new Date();
    noteConfig.modifiedAt = new Date();
    const newFilePath = filePath.replace(/\.md$/, ".copy.md");
    await this.writeNote(newFilePath, oldNote.markdown, noteConfig);
    const newNote = await this.getNote(newFilePath);
    if (newNote) {
      this.notes = [newNote, ...this.notes];
    }
    return newNote;
  }

  public async createNewNote(
    selectedSection: SelectedSection,
    fileName = "",
    markdown = ""
  ) {
    fileName = fileName || "unnamed_" + randomID() + ".md";
    let filePath;
    let tags: string[] = [];
    if (selectedSection.type === CrossnoteSectionType.Tag) {
      filePath = fileName;
      tags = [selectedSection.path];
    } else if (selectedSection.type === CrossnoteSectionType.Directory) {
      filePath = path.relative(
        this.dir,
        path.resolve(this.dir, selectedSection.path, fileName)
      );
    } else {
      filePath = fileName;
    }

    const noteConfig: NoteConfig = {
      tags: tags,
      modifiedAt: new Date(),
      createdAt: new Date(),
    };
    const newNote = await this.writeNote(filePath, markdown, noteConfig);
    if (newNote) {
      this.notes = [newNote, ...this.notes];
    }
    return newNote;
  }
}
