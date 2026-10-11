import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { marked } from "marked";
// "?raw" makes Vite bundle the file's text into the app, so the guide ships inside every build.
import readme from "../../README.md?raw";
import { Button, Card, TopBar } from "../components/ui";

interface Section {
  title: string;
  /** The section body as HTML. */
  html: string;
}

/** The part of the README between the guide markers, split into one section per "## " heading. */
function loadGuide(): Section[] {
  const guide = readme.split("<!-- guide:start -->")[1]?.split("<!-- guide:end -->")[0] ?? "";
  return guide
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const lineEnd = chunk.indexOf("\n");
      return {
        title: chunk.slice(0, lineEnd).trim(),
        html: marked.parse(chunk.slice(lineEnd), { async: false }),
      };
    });
}

const SECTIONS = loadGuide();

export function HelpPage({ onBack }: { onBack: () => void }) {
  const [version, setVersion] = useState("");
  const sections = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <Button onClick={onBack}>← Tree</Button>
        <h1 className="font-serif text-xl font-semibold">How to use Family Tree Builder</h1>
      </TopBar>

      <main className="flex-1 overflow-y-auto px-4 pt-6 pb-12">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5">
          <nav className="flex flex-wrap gap-2" aria-label="Sections">
            {SECTIONS.map((section, i) => (
              <Button
                key={section.title}
                size="sm"
                onClick={() => sections.current[i]?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {section.title}
              </Button>
            ))}
          </nav>

          {SECTIONS.map((section, i) => (
            <div
              key={section.title}
              ref={(element) => {
                sections.current[i] = element;
              }}
            >
              <Card title={section.title}>
                {/* The HTML comes from our own README, bundled at build time, never from user input. */}
                <div className="guide" dangerouslySetInnerHTML={{ __html: section.html }} />
              </Card>
            </div>
          ))}

          {version && <p className="text-center text-xs text-muted">Family Tree Builder version {version}</p>}
        </div>
      </main>
    </div>
  );
}
