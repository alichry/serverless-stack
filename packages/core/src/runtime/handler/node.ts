import path from "path";
import chalk from "chalk";
import { Definition } from "./definition";
import fs from "fs-extra";
import { State } from "../../state";
import { execSync } from "child_process";
import * as esbuild from "esbuild";
import { ICommandHooks } from "@aws-cdk/aws-lambda-nodejs";

const BUILD_CACHE: Record<string, esbuild.BuildResult> = {};

type Bundle = {
  loader?: { [ext: string]: esbuild.Loader };
  externalModules?: string[];
  nodeModules?: string[];
  esbuildConfig?: {
    define?: { [key: string]: string };
    keepNames?: boolean;
    plugins?: string;
  };
  commandHooks?: ICommandHooks;
  minify?: boolean;
};

export const NodeHandler: Definition<Bundle> = (opts) => {
  const dir = path.dirname(opts.handler);
  const ext = path.extname(opts.handler);
  const base = path.basename(opts.handler).split(".")[0];
  const file = [".ts", ".tsx", ".js", ".jsx"]
    .map((ext) => path.join(dir, base + ext))
    .find((file) => {
      const p = path.join(opts.srcPath, file);
      return fs.existsSync(p);
    })!;
  if (!file)
    throw new Error(`Cannot find a handler file for "${opts.handler}"`);

  const artifact = State.Function.artifactsPath(opts.root, opts.id);
  const target = path.join(
    artifact,
    opts.srcPath,
    path.dirname(file),
    base + ".js"
  );
  const bundle = opts.bundle || {
    minify: true,
  };
  const config: esbuild.BuildOptions = {
    loader: bundle.loader,
    minify: bundle.minify,
    define: bundle.esbuildConfig?.define,
    keepNames: bundle.esbuildConfig?.keepNames,
    entryPoints: [path.join(opts.srcPath, file)],
    bundle: true,
    external: [
      "aws-sdk",
      ...(bundle.externalModules || []),
      ...(bundle.nodeModules || []),
    ],
    sourcemap: "external",
    platform: "node",
    target: "node14",
    format: "cjs",
    outfile: target,
  };
  const plugins = bundle.esbuildConfig?.plugins
    ? path.join(opts.root, bundle.esbuildConfig.plugins)
    : undefined;

  return {
    build: async () => {
      const existing = BUILD_CACHE[opts.id];
      if (existing?.rebuild) {
        await existing.rebuild();
        return;
      }
      const result = await esbuild.build({
        ...config,
        sourcemap: "inline",
        plugins: plugins ? require(plugins) : undefined,
        minify: false,
        incremental: true,
      });
      BUILD_CACHE[opts.id] = result;
    },
    bundle: () => {
      runBeforeBundling(opts.srcPath, artifact, bundle);

      // We cannot use esbuild.buildSync(config) because it doesn't support plugins;
      const script = `
        const esbuild = require("esbuild")
        async function run() {
          const config = ${JSON.stringify({
            ...config,
            plugins,
          })}
          esbuild.build({
            ...config,
            plugins: config.plugins ? require(config.plugins) : undefined
          })
        }
        run()
      `;
      fs.rmSync(artifact, {
        recursive: true,
        force: true,
      });
      fs.mkdirpSync(artifact);
      const builder = path.join(artifact, "builder.js");
      fs.writeFileSync(builder, script);
      try {
        execSync(`node "${builder}"`, {
          stdio: "inherit",
        });
      } catch {
        throw new Error("There was a problem transpiling the Lambda handler.");
      }
      fs.rmSync(builder);

      runBeforeInstall(opts.srcPath, artifact, bundle);

      installNodeModules(opts.srcPath, artifact, bundle);

      runAfterBundling(opts.srcPath, artifact, bundle);

      return {
        directory: artifact,
        handler: path.join(opts.srcPath, opts.handler),
      };
    },
    run: {
      command: "npx",
      args: ["aws-lambda-ric", target.replace(".js", ext)],
      env: {
        NODE_OPTIONS: "--enable-source-maps",
        AWS_LAMBDA_NODEJS_USE_ALTERNATIVE_CLIENT_1: "true",
      },
    },
    watcher: {
      include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"].map((glob) =>
        path.resolve(path.join(opts.srcPath, glob))
      ),
      ignore: [],
    },
  };
};

// Do not re-install nodeModules for the same srcPath and nodeModules settings
const existingNodeModulesBySrcPathModules: Record<string, string> = {};

function installNodeModules(
  srcPath: string,
  targetPath: string,
  bundle: Bundle
) {
  if (!bundle.nodeModules) return;
  // If nodeModules have been installed for the same srcPath, copy the
  // "node_modules" folder over. Do not re-install.
  const modulesStr = JSON.stringify(bundle.nodeModules.slice().sort());
  const srcPathModules = `${srcPath}/${modulesStr}`;
  const existingPath = existingNodeModulesBySrcPathModules[srcPathModules];
  if (existingPath) {
    fs.copySync(
      path.join(existingPath, "node_modules"),
      path.join(targetPath, "node_modules")
    );
    return;
  }

  // Find 'package.json' at handler's srcPath.
  const pkgPath = path.join(srcPath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `Cannot find a "package.json" in the function's srcPath: ${path.resolve(
        srcPath
      )}`
    );
  }

  // Determine dependencies versions, lock file and installer
  const dependencies = extractDependencies(pkgPath, bundle.nodeModules);
  let installer = "npm";
  let lockFile;
  if (fs.existsSync(path.join(srcPath, "package-lock.json"))) {
    installer = "npm";
    lockFile = "package-lock.json";
  } else if (fs.existsSync(path.join(srcPath, "yarn.lock"))) {
    installer = "yarn";
    lockFile = "yarn.lock";
  }

  // Create dummy package.json, copy lock file if any and then install
  const outputPath = path.join(targetPath, "package.json");
  fs.ensureFileSync(outputPath);
  fs.writeJsonSync(outputPath, { dependencies });
  if (lockFile) {
    fs.copySync(path.join(srcPath, lockFile), path.join(targetPath, lockFile));
  }

  // Install dependencies
  try {
    execSync(`${installer} install`, {
      cwd: targetPath,
      stdio: "pipe",
    });
  } catch (e) {
    console.log(chalk.red(`There was a problem installing nodeModules.`));
    throw e;
  }

  // Store the path to the installed "node_modules"
  if (fs.existsSync(path.join(targetPath, "node_modules"))) {
    existingNodeModulesBySrcPathModules[srcPathModules] =
      path.resolve(targetPath);
  }
}

/**
 * Extract versions for a list of modules.
 *
 * First lookup the version in the package.json and then fallback to requiring
 * the module's package.json. The fallback is needed for transitive dependencies.
 */
function extractDependencies(
  pkgPath: string,
  modules: string[]
): { [key: string]: string } {
  const dependencies: { [key: string]: string } = {};

  const pkgJson = fs.readJsonSync(pkgPath);

  const pkgDependencies = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
    ...(pkgJson.peerDependencies ?? {}),
  };

  for (const mod of modules) {
    try {
      const version =
        pkgDependencies[mod] ?? require(`${mod}/package.json`).version; // eslint-disable-line @typescript-eslint/no-var-requires
      dependencies[mod] = version;
    } catch (err) {
      throw new Error(
        `Cannot extract version for module '${mod}'. Check that it's referenced in your package.json or installed.`
      );
    }
  }

  return dependencies;
}

function runBeforeBundling(srcPath: string, buildPath: string, bundle: Bundle) {
  // Build command
  const cmds = bundle.commandHooks?.beforeBundling(srcPath, buildPath) ?? [];
  if (cmds.length === 0) {
    return;
  }

  try {
    execSync(cmds.join(" && "), {
      cwd: srcPath,
      stdio: "pipe",
    });
  } catch (e) {
    console.log(
      chalk.red(`There was a problem running "beforeBundling" command.`)
    );
    throw e;
  }
}

function runBeforeInstall(srcPath: string, buildPath: string, bundle: Bundle) {
  // Build command
  const cmds = bundle.commandHooks?.beforeInstall(srcPath, buildPath) ?? [];
  if (cmds.length === 0) {
    return;
  }

  try {
    execSync(cmds.join(" && "), {
      cwd: srcPath,
      stdio: "pipe",
    });
  } catch (e) {
    console.log(
      chalk.red(`There was a problem running "beforeInstall" command.`)
    );
    throw e;
  }
}

function runAfterBundling(srcPath: string, buildPath: string, bundle: Bundle) {
  // Build command
  const cmds = bundle.commandHooks?.afterBundling(srcPath, buildPath) ?? [];
  if (cmds.length === 0) {
    return;
  }

  try {
    execSync(cmds.join(" && "), {
      cwd: srcPath,
      stdio: "pipe",
    });
  } catch (e) {
    console.log(
      chalk.red(`There was a problem running "afterBundling" command.`)
    );
    throw e;
  }
}
