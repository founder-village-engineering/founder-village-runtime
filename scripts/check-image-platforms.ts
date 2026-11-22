import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const digest = /^sha256:[a-f0-9]{64}$/;
const exec = promisify(execFile);

async function inspect(image: string, children?: [string, string]) {
  const { stdout } = await exec(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", image],
    { timeout: 60_000 },
  );
  const index = JSON.parse(stdout) as {
    manifests?: {
      digest: string;
      platform?: { os: string; architecture: string };
    }[];
  };
  for (const [position, architecture] of ["amd64", "arm64"].entries()) {
    const expected = children?.[position]?.split("@")[1];
    const matches = index.manifests?.filter(
      ({ platform }) =>
        platform?.os === "linux" && platform.architecture === architecture,
    );
    if (
      matches?.length !== 1 ||
      !digest.test(matches[0]?.digest ?? "") ||
      (expected && matches[0]?.digest !== expected)
    )
      throw new Error(
        `missing or unexpected linux/${architecture} image descriptor`,
      );
  }
}

const [release, amd, arm] = process.argv.slice(2);
if (release) {
  const repo = release.split("@")[0];
  if (
    ![release, amd, arm].every(
      (ref) =>
        ref?.startsWith(`${repo}@`) && digest.test(ref.split("@")[1] ?? ""),
    ) ||
    !amd ||
    !arm
  )
    throw new Error(
      "one repository and three immutable image references required",
    );
  await inspect(release, [amd, arm]);
  console.log(
    "release index contains the exact scanned AMD64 and ARM64 images",
  );
} else {
  const locked = JSON.parse(
    await readFile("config/images.lock.json", "utf8"),
  ) as Record<string, string>;
  await Promise.all(
    Object.entries(locked).map(async ([name, image]) => {
      try {
        await inspect(image);
      } catch {
        throw new Error(`locked image ${name} failed the platform check`);
      }
    }),
  );
  console.log("all locked images include Linux AMD64 and ARM64");
}
