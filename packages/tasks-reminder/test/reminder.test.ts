/**
 * The reminder's decision logic and the installer's artifacts — everything
 * short of osascript and launchctl themselves, which are shelled out and
 * verified by hand (§16.6). Nothing here touches the network.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, plistPath, renderPlist, uninstall, writeInstall } from "../src/install.ts";
import {
  dialogText,
  loadReminderConfig,
  readStamp,
  reminderPaths,
  shouldFire,
  writeStamp,
} from "../src/reminder.ts";

const item = (title: string, due: string) => ({ id: title, title, due, due_human: due });

describe("the daily gate", () => {
  test("silent before the hour, silent once shown today, fires otherwise", () => {
    const at = (h: number) => new Date(2026, 8, 17, h, 15);
    expect(shouldFire(at(8), null, 9).fire).toBe(false);
    expect(shouldFire(at(9), null, 9).fire).toBe(true);
    const today = at(10).toLocaleDateString("en-CA");
    expect(shouldFire(at(10), today, 9).fire).toBe(false);
    expect(shouldFire(at(10), "2026-09-16", 9).fire).toBe(true);
    expect(shouldFire(at(7), "2026-09-16", 7).fire).toBe(true);
  });

  test("the stamp round-trips through disk and tolerates absence", () => {
    const home = mkdtempSync(join(tmpdir(), "reminder-"));
    const { stamp } = reminderPaths(home);
    expect(readStamp(stamp)).toBeNull();
    writeStamp(stamp, "2026-09-17");
    expect(readStamp(stamp)).toBe("2026-09-17");
  });
});

describe("the dialog", () => {
  test("nothing due → no dialog; otherwise a count, a bulleted list, and a cap", () => {
    expect(dialogText({ needs_attention: 0, overdue: [], today: [], upcoming: [] })).toBeNull();
    expect(
      dialogText({
        needs_attention: 0,
        overdue: [],
        today: [],
        upcoming: [item("x", "in 2 days")],
      }),
    ).toBeNull(); // upcoming alone never interrupts
    const one = dialogText({
      needs_attention: 1,
      overdue: [],
      today: [item("water plants", "today")],
      upcoming: [item("rent", "in 2 days")],
    }) as string;
    expect(one).toContain("1 task needs attention");
    expect(one).toContain("• water plants — today");
    expect(one).toContain("1 more coming up");
    const many = dialogText(
      {
        needs_attention: 8,
        overdue: Array.from({ length: 8 }, (_, i) => item(`t${i}`, `${i + 1} days overdue`)),
        today: [],
        upcoming: [],
      },
      6,
    ) as string;
    expect(many).toContain("8 tasks need attention");
    expect(many).toContain("…and 2 more");
    expect(many).not.toContain("t7");
  });
});

describe("config", () => {
  test("env overrides the file; incomplete config is null", () => {
    const home = mkdtempSync(join(tmpdir(), "reminder-"));
    expect(loadReminderConfig({}, home)).toBeNull();
    const launchctl = () => ({ exitCode: 0, stderr: "" });
    writeInstall(
      {
        home,
        repoRoot: "/repo",
        bunPath: "/bun",
        gatewayUrl: "https://gw.example/mcp",
        consoleUrl: "https://gw.example",
        clientId: "cid",
        audience: "aud",
      },
      launchctl,
    );
    const fromFile = loadReminderConfig({}, home);
    expect(fromFile?.gatewayUrl).toBe("https://gw.example/mcp");
    expect(fromFile?.earliestHour).toBe(9);
    expect(fromFile?.tokenCachePath).toBe(reminderPaths(home).tokenCache);
    const overridden = loadReminderConfig(
      { TASKS_REMINDER_CLIENT_ID: "other", TASKS_REMINDER_EARLIEST_HOUR: "7" },
      home,
    );
    expect(overridden?.clientId).toBe("other");
    expect(overridden?.earliestHour).toBe(7);
  });
});

describe("the installer", () => {
  test("writes a valid agent plist and a 0600 config, loads it, uninstalls cleanly", () => {
    const home = mkdtempSync(join(tmpdir(), "reminder-"));
    const calls: string[][] = [];
    const launchctl = (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    };
    const opts = {
      home,
      repoRoot: "/srv/brain",
      bunPath: "/srv/bun/bin/bun",
      gatewayUrl: "https://gw.example/mcp",
      consoleUrl: "https://gw.example",
      clientId: "cid",
    };
    const res = writeInstall(opts, launchctl);
    expect(res.filesWritten).toEqual([reminderPaths(home).config, plistPath(home)]);
    const plist = readFileSync(plistPath(home), "utf8");
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain("<string>/srv/brain/packages/tasks-reminder/src/reminder.ts</string>");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/srv/brain</string>");
    expect(plist).toContain("<key>Hour</key><integer>9</integer>");
    expect(plist).toContain("<key>StartInterval</key><integer>1800</integer>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).not.toContain("SECRET");
    expect(readFileSync(reminderPaths(home).config, "utf8")).not.toContain("secret");
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
    expect(renderPlist({ ...opts, earliestHour: 7 })).toContain("<integer>7</integer>");

    const removed = uninstall(home, launchctl);
    expect(removed).toEqual([plistPath(home)]);
    expect(calls.at(-1)?.[0]).toBe("bootout");
    expect(uninstall(home, launchctl)).toEqual([]);
  });
});
