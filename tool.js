// knitoutjs's project tool: latticework on a project, its files down the side
import { mountProject } from "./core/project-view.js";
import { PROJECT_TOOLS } from "./core/project.js";
import { TOOLS, toolsFor, fileExtension } from "./files.js";

export default function KnitoutProjectTool(handle, element) {
  // the repo patchwork gives a tool resolves through any draft overlay above
  // it; updating a project from before is done under it, on the doc itself
  const repo = element.repo;
  return mountProject(element, {
    project: handle,
    repo,
    baseRepo: repo.baseRepo ?? repo,
    hive: element.hive,
    tools: { TOOLS, toolsFor, fileExtension },
    self: PROJECT_TOOLS,
  });
}
