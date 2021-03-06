/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  AggregatedResult,
  CoverageMap,
  FileCoverage,
  CoverageSummary,
  TestResult,
} from 'types/TestResult';
import typeof {worker} from './coverage_worker';

import type {GlobalConfig} from 'types/Config';
import type {Context} from 'types/Context';
import type {Test} from 'types/TestRunner';

import {clearLine} from 'jest-util';
import {createReporter} from 'istanbul-api';
import chalk from 'chalk';
import isCI from 'is-ci';
import istanbulCoverage from 'istanbul-lib-coverage';
import libSourceMaps from 'istanbul-lib-source-maps';
import Worker from 'jest-worker';
import BaseReporter from './base_reporter';
import path from 'path';
import glob from 'glob';

const FAIL_COLOR = chalk.bold.red;
const RUNNING_TEST_COLOR = chalk.bold.dim;

const isInteractive = process.stdout.isTTY && !isCI;

type CoverageWorker = {worker: worker};

export default class CoverageReporter extends BaseReporter {
  _coverageMap: CoverageMap;
  _globalConfig: GlobalConfig;
  _sourceMapStore: any;

  constructor(globalConfig: GlobalConfig) {
    super();
    this._coverageMap = istanbulCoverage.createCoverageMap({});
    this._globalConfig = globalConfig;
    this._sourceMapStore = libSourceMaps.createSourceMapStore();
  }

  onTestResult(
    test: Test,
    testResult: TestResult,
    aggregatedResults: AggregatedResult,
  ) {
    if (testResult.coverage) {
      this._coverageMap.merge(testResult.coverage);
      // Remove coverage data to free up some memory.
      delete testResult.coverage;

      Object.keys(testResult.sourceMaps).forEach(sourcePath => {
        let coverage: FileCoverage, inputSourceMap: ?Object;
        try {
          coverage = this._coverageMap.fileCoverageFor(sourcePath);
          ({inputSourceMap} = coverage.toJSON());
        } finally {
          if (inputSourceMap) {
            this._sourceMapStore.registerMap(sourcePath, inputSourceMap);
          } else {
            this._sourceMapStore.registerURL(
              sourcePath,
              testResult.sourceMaps[sourcePath],
            );
          }
        }
      });
    }
  }

  async onRunComplete(
    contexts: Set<Context>,
    aggregatedResults: AggregatedResult,
  ) {
    await this._addUntestedFiles(this._globalConfig, contexts);
    let map = this._coverageMap;
    let sourceFinder: Object;
    if (this._globalConfig.mapCoverage) {
      ({map, sourceFinder} = this._sourceMapStore.transformCoverage(map));
    }

    const reporter = createReporter();
    try {
      if (this._globalConfig.coverageDirectory) {
        reporter.dir = this._globalConfig.coverageDirectory;
      }

      let coverageReporters = this._globalConfig.coverageReporters || [];
      if (
        !this._globalConfig.useStderr &&
        coverageReporters.length &&
        coverageReporters.indexOf('text') === -1
      ) {
        coverageReporters = coverageReporters.concat(['text-summary']);
      }

      reporter.addAll(coverageReporters);
      reporter.write(map, sourceFinder && {sourceFinder});
      aggregatedResults.coverageMap = map;
    } catch (e) {
      console.error(
        chalk.red(`
        Failed to write coverage reports:
        ERROR: ${e.toString()}
        STACK: ${e.stack}
      `),
      );
    }

    this._checkThreshold(this._globalConfig, map);
  }

  async _addUntestedFiles(
    globalConfig: GlobalConfig,
    contexts: Set<Context>,
  ): Promise<void> {
    const files = [];

    contexts.forEach(context => {
      const config = context.config;
      if (
        globalConfig.collectCoverageFrom &&
        globalConfig.collectCoverageFrom.length
      ) {
        context.hasteFS
          .matchFilesWithGlob(globalConfig.collectCoverageFrom, config.rootDir)
          .forEach(filePath =>
            files.push({
              config,
              path: filePath,
            }),
          );
      }
    });

    if (!files.length) {
      return;
    }

    if (isInteractive) {
      process.stderr.write(
        RUNNING_TEST_COLOR('Running coverage on untested files...'),
      );
    }

    let worker: CoverageWorker;

    if (this._globalConfig.maxWorkers <= 1) {
      worker = require('./coverage_worker');
    } else {
      // $FlowFixMe: assignment of a worker with custom properties.
      worker = new Worker(require.resolve('./coverage_worker'), {
        exposeMethods: ['worker'],
        maxRetries: 2,
        numWorkers: this._globalConfig.maxWorkers,
      });
    }

    const instrumentation = files.map(async fileObj => {
      const filename = fileObj.path;
      const config = fileObj.config;

      if (!this._coverageMap.data[filename]) {
        try {
          const result = await worker.worker({
            config,
            globalConfig,
            path: filename,
          });

          if (result) {
            this._coverageMap.addFileCoverage(result.coverage);

            if (result.sourceMapPath) {
              this._sourceMapStore.registerURL(filename, result.sourceMapPath);
            }
          }
        } catch (error) {
          console.error(
            chalk.red(
              [
                `Failed to collect coverage from ${filename}`,
                `ERROR: ${error.message}`,
                `STACK: ${error.stack}`,
              ].join('\n'),
            ),
          );
        }
      }
    });

    try {
      await Promise.all(instrumentation);
    } catch (err) {
      // Do nothing; errors were reported earlier to the console.
    }

    if (isInteractive) {
      clearLine(process.stderr);
    }

    if (worker && typeof worker.end === 'function') {
      worker.end();
    }
  }

  _checkThreshold(globalConfig: GlobalConfig, map: CoverageMap) {
    if (globalConfig.coverageThreshold) {
      function check(name, thresholds, actuals) {
        return [
          'statements',
          'branches',
          'lines',
          'functions',
        ].reduce((errors, key) => {
          const actual = actuals[key].pct;
          const actualUncovered = actuals[key].total - actuals[key].covered;
          const threshold = thresholds[key];

          if (threshold != null) {
            if (threshold < 0) {
              if (threshold * -1 < actualUncovered) {
                errors.push(
                  `Jest: Uncovered count for ${key} (${actualUncovered})` +
                    `exceeds ${name} threshold (${-1 * threshold})`,
                );
              }
            } else if (actual < threshold) {
              errors.push(
                `Jest: Coverage for ${key} (${actual}` +
                  `%) does not meet ${name} threshold (${threshold}%)`,
              );
            }
          }
          return errors;
        }, []);
      }

      const expandedThresholds = {};
      Object.keys(globalConfig.coverageThreshold).forEach(filePathOrGlob => {
        if (filePathOrGlob !== 'global') {
          const pathArray = glob.sync(filePathOrGlob);
          pathArray.forEach(filePath => {
            expandedThresholds[path.resolve(filePath)] =
              globalConfig.coverageThreshold[filePathOrGlob];
          });
        } else {
          expandedThresholds.global = globalConfig.coverageThreshold.global;
        }
      });

      const filteredCoverageSummary = map
        .files()
        .filter(
          filePath => Object.keys(expandedThresholds).indexOf(filePath) === -1,
        )
        .map(filePath => map.fileCoverageFor(filePath))
        .reduce((summary: ?CoverageSummary, fileCov: FileCoverage) => {
          return summary === undefined || summary === null
            ? (summary = fileCov.toSummary())
            : summary.merge(fileCov.toSummary());
        }, undefined);

      const errors = [].concat.apply(
        [],
        Object.keys(expandedThresholds)
          .map(thresholdKey => {
            if (thresholdKey === 'global') {
              if (filteredCoverageSummary !== undefined) {
                return check(
                  'global',
                  expandedThresholds.global,
                  filteredCoverageSummary,
                );
              } else {
                return [];
              }
            } else {
              if (map.files().indexOf(thresholdKey) !== -1) {
                return check(
                  thresholdKey,
                  expandedThresholds[thresholdKey],
                  map.fileCoverageFor(thresholdKey).toSummary(),
                );
              } else {
                return [
                  `Jest: Coverage data for ${thresholdKey} was not found.`,
                ];
              }
            }
          })
          .filter(errorArray => {
            return (
              errorArray !== undefined &&
              errorArray !== null &&
              errorArray.length > 0
            );
          }),
      );

      if (errors.length > 0) {
        this.log(`${FAIL_COLOR(errors.join('\n'))}`);
        this._setError(new Error(errors.join('\n')));
      }
    }
  }

  // Only exposed for the internal runner. Should not be used
  getCoverageMap(): CoverageMap {
    return this._coverageMap;
  }
}
