import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { BadgeInfo, Box, Calculator, Camera, ClipboardCheck, Clock3, Cloud, Download, FileImage, Hammer, HardDrive, ImagePlus, KeyRound, Layers3, Library, Save, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { createAirRunProgram, generateToolpath, downloadText } from "./cam";
import { createBlankDepthMap, createDemoDepthMap, createReliefGeometry } from "./geometry";
import { assetUrlToDepthMap, blendDepthMaps, createMultiViewDepthMap, fileToDepthMap, processDepthMap } from "./imageProcessing";
import { DepthEditor } from "./DepthEditor";
import { AiMeshViewer } from "./AiMeshViewer";
import { exportGeometryAsStl, geometryToStlString } from "./modelExport";
import { ReliefViewer } from "./ReliefViewer";
import { SimulationViewer } from "./SimulationViewer";
import { createOperatorPackageMarkdown } from "./exportPackage";
import { createCostEstimate, formatCurrencyRange, type CostEstimate } from "./costEstimate";
import { createPackageManifest, createQualityReport, createSafetyReport, createSafetyReportMarkdown } from "./reports";
import { createZipBlob, downloadBlob, type ZipFile } from "./zipPackage";
import { ai3dProviders, getAi3dProvider, isProviderAvailable, type Ai3dProviderId } from "./aiProviders";
import { analyzeMaterialRemoval, type MaterialRemovalReport } from "./simulationAnalysis";
import { isSupportedToolpathFile, parseGcodeToToolpath } from "./gcodeImport";
import {
  applyMachineProfile,
  applyMaterialProfile,
  applyProcessTemplate,
  applyToolProfile,
  getMachineProfile,
  getMaterialProfile,
  getToolProfile,
  hasCriticalIssue,
  machineProfiles,
  materialProfiles,
  processTemplates,
  toolProfiles,
  validateGcodeProgram,
  validateManufacturingSetup
} from "./manufacturingProfiles";
import { analyzeDepthMapQuality, createManufacturingQualityReport } from "./quality";
import type { ManufacturingQualityReport } from "./quality";
import type { CarvingImage, DepthMap, GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";
import type { MachineProfile, MaterialProfile, ProcessTemplate, SafetyIssue, ToolProfile } from "./manufacturingProfiles";

const defaultSettings: ModelSettings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: 15,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: 1.25,
  reliefAngleDeg: 220,
  contrast: 1.45,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  endTransitionMm: 1.2,
  toolDiameter: 4,
  stepoverDeg: 1.2,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.16,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

type ToolpathKind = "rough" | "finish" | "rest";
type WorkflowStage = "project" | "source" | "model" | "process" | "cam" | "tasks" | "deployment" | "feedback";
type ModelSubStage = "local" | "ai" | "inspection";
type WorkbenchView = "model" | "simulation" | "heatmap" | "gcode" | "report";
type UserRole = "designer" | "process" | "operator" | "admin";
type TaskEvent = {
  id: string;
  title: string;
  detail: string;
  status: "ok" | "warning" | "error";
  category: "source" | "model" | "process" | "cam" | "feedback";
  timestamp: string;
  actionLinks?: Array<{ label: string; href: string; tone?: "primary" | "warning" }>;
};

type TaskJob = {
  id: string;
  title: string;
  detail: string;
  status: "running" | "done" | "error" | "canceled";
  category: TaskEvent["category"];
  startedAt: number;
  startedLabel: string;
  finishedLabel?: string;
  durationMs?: number;
  progress: number;
  retryAction?: TaskRetryAction;
  logs: TaskJobLog[];
};

type TaskRetryAction = "generate-ai-mesh" | "repair-mesh" | "remesh" | "generate-toolpath" | "generate-finish-toolpath";

type TaskJobLog = {
  id: string;
  time: string;
  message: string;
};

type V3EngineStatus = {
  id: string;
  name: string;
  role: string;
  available: boolean;
  adapterReady: boolean;
  command: string | null;
  version: string | null;
  notes: string;
};

type V3OrchestratorJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  requestedEngine: string;
  selectedEngine: string | null;
  modelUrl: string;
  createdAt: string;
  updatedAt: string;
  workDir: string | null;
  currentStage?: string;
  progress?: number;
  pipeline?: Array<{
    id: string;
    label: string;
    status: "queued" | "running" | "completed" | "review" | "skipped" | "failed";
    message: string;
    updatedAt?: string;
  }>;
  artifacts: string[];
  logs: Array<{ time: string; message: string }>;
  cancelRequested?: boolean;
  result: null | {
    engine: string;
    fallbackFrom: string;
    externalAvailable: boolean;
    adapterReady: boolean;
    adapterReport?: {
      status: string;
      engine: string;
      error?: string | null;
      durationMs?: number;
      metrics?: {
        neutralToolpath?: {
          status?: string;
          path?: string | null;
          cutterEnvelopeReportPath?: string | null;
          synthetic?: boolean;
          fixture?: boolean;
          heightfieldPreview?: boolean;
          previewScaffold?: boolean;
          pointCount?: number | null;
          generatedByExternalCommand?: boolean;
        };
      };
    } | null;
    camoticsAdapterReport?: {
      status: string;
      engine: string;
      error?: string | null;
      durationMs?: number;
      simulationResultPath?: string;
      outputs?: {
        simulationResult?: string;
      };
      metrics?: {
        resultPath?: string | null;
      };
    } | null;
    toolpath: GeneratedToolpath;
    summary: {
      meshQuality?: {
        score: number;
        verdict: string;
        triangleCount: number;
        boundaryEdges: number;
        nonManifoldEdges: number;
        degenerateFaces: number;
      };
      repairPlan?: {
        status: string;
        statusText: string;
        recommendedActions: Array<{
          id: string;
          priority: string;
          label: string;
          engine: string;
          reason: string;
        }>;
      };
      repairExecution?: {
        status: string;
        summary: string;
        autoRepairEnabled: boolean;
        repairRequired: boolean;
        repairSuggested: boolean;
        importedRepair?: {
          imported: boolean;
          sourcePath: string | null;
          targetPath: string;
          filename?: string;
          url?: string;
          reason?: string;
        };
        outputs?: Array<{
          id: string;
          role: string;
          label: string;
          path: string;
          url: string | null;
          exists: boolean;
          selectedForCam?: boolean;
        }>;
        repairedMeshQuality?: {
          score?: number;
          verdict?: string;
          triangleCount?: number;
          boundaryEdges?: number;
          nonManifoldEdges?: number;
          degenerateFaces?: number;
          artifact?: string;
          modelPath?: string;
          modelUrl?: string | null;
          error?: string;
        };
      };
      camInputPlan?: {
        schema?: string;
        status: string;
        summary: string;
        selectedModelKind: string;
        selectedModelUrl?: string | null;
        selectedModelPath?: string | null;
        modelSelection?: {
          schema: string;
          status: string;
          selectedModelId: string | null;
          selectedModelUrl: string | null;
          selectedModelPath: string | null;
          selectedModelRole: string | null;
          repairExecutionStatus: string | null;
          repairRequired: boolean;
          blockingReason: string | null;
          selectionReason: string;
          candidates: Array<{
            id: string;
            role: string;
            label: string;
            path: string;
            url: string | null;
            exists: boolean;
            selectedForCam: boolean;
          }>;
        };
        preferredExternalEngine: string;
        adapterModelPolicy: string;
        gate: {
          allowInternalFallback: boolean;
          allowExternalCamTrial: boolean;
          allowProductionNc: boolean;
          reason: string;
        };
      };
      engineReadiness?: {
        selectedEngine: string;
        selectedEngineName: string;
        externalReady: boolean;
        enableExternalCamAdapters: boolean;
        summary: string;
        engines: Array<{
          id: string;
          name: string;
          required: boolean;
          available: boolean;
          adapterReady: boolean;
          status: string;
        }>;
      };
      camEngineSelection?: {
        schema: string;
        selectedEngine: string;
        selectedEngineName: string;
        strategy: string;
        fallbackUsed: boolean;
        fallbackReason: string;
        externalAttemptAllowed: boolean;
        externalReady: boolean;
        camInputStatus: string;
        camInputModelKind: string;
        candidates?: Array<{
          id: string;
          rank: number;
          name: string;
          available: boolean;
          adapterReady: boolean;
          selected: boolean;
          canAttemptNow: boolean;
          blockers?: string[];
        }>;
        requiredNextActions?: string[];
      };
      openSourceCamExecutionPlan?: {
        schema: string;
        selectedEngine: string;
        selectedEngineName: string;
        readyStageCount: number;
        totalStageCount: number;
        selectedStageId: string | null;
        selectedStageStatus: string;
        summary: string;
        stages?: Array<{
          id: string;
          order: number;
          title: string;
          priority: string;
          status: string;
          selected: boolean;
          canAttemptNow: boolean;
          acceptance: string;
        }>;
        globalAcceptanceCommands?: string[];
        productionLocks?: string[];
      };
      nativeCamReadiness?: {
        schema: string;
        level: string;
        readyCount: number;
        requiredCount: number;
        summary: string;
        requiredActions?: string[];
      };
      camServerConfig?: {
        schema: string;
        status: string;
        selectedEngine: string;
        selectedEngineName: string;
        nativeCamLevel: string;
        missingRequired: string[];
        deploymentValidation?: V3CamServerDeploymentValidation | null;
      };
      externalCamRecipe?: {
        status: string;
        engine: {
          selectedEngine: string;
          selectedEngineName: string;
          engineFamily: string;
          available: boolean;
          adapterReady: boolean;
          externalReady: boolean;
        };
        model?: {
          selectedModelKind: string;
          adapterModelPolicy: string;
          repairStatus: string;
          modelSelection?: {
            selectedModelId: string | null;
            selectedModelRole: string | null;
            selectionReason: string;
            blockingReason: string | null;
          } | null;
        };
        operations?: Array<{
          id: string;
          enabled: boolean;
          strategy: string;
          target: string;
        }>;
        postprocess?: {
          camMode: string;
          postProcessor: string;
          rotaryOutputAxis: string | null;
          lengthAxis: string;
          depthAxis: string;
          policy: string;
        };
        blockingIssues?: string[];
        nextAdapterSteps?: string[];
      };
      adapterPreflight?: {
        status: string;
        summary: string;
        selectedEngine: string;
        canAttemptExternal: boolean;
        willUseFallback: boolean;
        checks: Array<{
          id: string;
          ok: boolean;
          detail: string;
        }>;
      };
      productionGate?: {
        level: string;
        allowProductionNc: boolean;
        allowTrialNc: boolean;
        allowAirRun: boolean;
        summary: string;
        blockers: string[];
        warnings: string[];
        requiredActions: string[];
        simulationEvidence?: {
          level: string;
          productionUnlockEligible: boolean;
          realMaterialRemovalVerified: boolean;
          synthetic: boolean;
          engine: string;
          adapterStatus: string;
          summary: string;
          evidenceQuality?: {
            productionEvidenceEligible: boolean;
            status: string;
            missing?: string[];
            summary?: string;
            machineContext?: {
              status: string;
              message?: string | null;
            };
          } | null;
        };
        checks: {
          fitRate: number;
          missCount: number;
          pointCount: number;
          estimatedMinutes: number;
        };
      };
      postprocessProfile?: {
        camMode: string;
        postProcessor: string;
        postProcessorName: string;
        selectedEngine: string;
        resultEngine: string;
        fallbackUsed: boolean;
        packageLevel: string;
        coordinateMapping?: {
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          length: string;
          depth: string;
          rotary: string | null;
          gcodeHeaderMarkers?: Record<string, string | number | null>;
        };
        machine?: {
          machineProfileId?: string | null;
          rotaryOutputAxis?: string | null;
          rotaryWrapPerRevolutionMm?: number | null;
          notes?: string;
        };
        tool?: {
          toolProfileId?: string | null;
          toolDiameterMm: number;
          stepoverMm: number;
          stepoverDeg: number;
          description: string;
        };
        cutting?: {
          feedRateMmMin: number;
          spindleRpm: number;
          safeZMm: number;
          estimatedMinutes: number;
          pointCount: number;
        };
      };
      machineControllerProfile?: {
        id: string;
        name: string;
        camMode: string;
        controllerClass: string;
        axisMapping?: {
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          planarWidthAxis?: string | null;
          description?: string;
        };
        rotary?: {
          enabled: boolean;
          outputAxis: string | null;
          outputUnit: string | null;
          wrapPerRevolutionMm: number | null;
          warning?: string | null;
        };
        dialect?: {
          allowedG: string[];
          allowedM: string[];
          allowedWords: string[];
          expectedRotaryAxis: string | null;
          forbiddenWords?: string[];
        };
        safety?: {
          safeZMm: number;
          spindleRpm: number;
          feedRateMmMin: number;
          airRunRequired: boolean;
          softTrialRequiredBeforeProduction: boolean;
          notes: string[];
        };
      };
      ncStaticAnalysis?: {
        level: "ready" | "review" | "critical";
        summary: string;
        criticalIssues: string[];
        warningIssues: string[];
        programs: Array<{
          filename: string;
          role: string;
          motionLineCount: number;
          level: string;
          axisCounts: {
            x: number;
            y: number;
            z: number;
            a: number;
          };
          zRange: {
            min: number | null;
            max: number | null;
          };
        }>;
      };
      camHandoffQuality?: {
        schema: string;
        level: "ready" | "review" | "critical";
        source: string;
        selectedEngine: string | null;
        resultEngine: string;
        synthetic: boolean;
        importedFixture: boolean;
        sourceSnapshot?: {
          schema: string;
          kind: string;
          path: string;
          sizeBytes: number;
          sha256: string;
          selectedEngine: string | null;
          adapterEngine: string | null;
          adapterStatus: string | null;
          generatedByExternalCommand: boolean;
        } | null;
        summary: string;
        criticalIssues: string[];
        warningIssues: string[];
        metrics: {
          pointCount: number;
          xCoverage: number;
          rotaryCoverage: number | null;
          samplingQuality?: {
            level?: string;
            hitRate?: number | null;
            rows?: number | null;
            cols?: number | null;
            stepToCutterRatio?: number | null;
            maxLinearStepMm?: number | null;
            adaptiveSampling?: boolean;
            samplingSource?: string | null;
            targetStepoverMm?: number | null;
            targetStepoverDeg?: number | null;
            rowCapHit?: boolean;
            colCapHit?: boolean;
            blockers?: string[];
            warnings?: string[];
          } | null;
        };
      };
      neutralToolpathImportValidation?: {
        schema: string;
        status: "ready" | "review" | "critical";
        postprocessEligible: boolean;
        summary: string;
        sourceName?: string | null;
        engine?: string | null;
        classification?: {
          synthetic: boolean;
          fixture: boolean;
          previewScaffold: boolean;
          imported: boolean;
          generatedByExternalCommand: boolean;
        };
        coordinate?: {
          lengthAxis: string | null;
          rotaryAxis: string | null;
          depthAxis: string | null;
          rotaryUnit: string | null;
        };
        sourceBinding?: {
          schema: string;
          status: string;
          sourceName?: string | null;
          submitted?: {
            sha256: string;
            pointCount: number;
          };
          importedArtifact?: {
            sha256: string;
            matchesSubmitted: boolean;
          } | null;
          postprocessArtifact?: {
            sha256: string;
          } | null;
          sourceSnapshot?: {
            sha256: string;
            matchesPostprocessArtifact: boolean;
          } | null;
          summary?: string;
        } | null;
        metrics?: {
          sourcePointCount: number;
          normalizedPointCount: number;
          invalidPointCount: number;
          missingRotaryCount: number;
          outOfRangeCount: number;
          xMin: number | null;
          xMax: number | null;
          zMin: number | null;
          zMax: number | null;
        };
        machineFit?: {
          schema: string;
          level: "ok" | "review" | "critical";
          summary: string;
          targetMachine?: {
            controllerClass: string;
            axisMapping: string;
            postProcessor: string | null;
            rotaryOutputAxis: string;
            rotaryWrapPerRevolutionMm: number;
          };
          stockEnvelope?: {
            safeLeftX: number;
            safeRightX: number;
            safeMachiningLengthMm: number;
            depthLimitMm: number;
          };
          coverage?: {
            xCoverageRatio: number;
            rotarySpanDeg: number;
            expectedRotaryCoverageDeg: number;
            rotaryCoverageRatio: number | null;
            depthMax: number | null;
          };
          riskCounts?: {
            holdZonePointCount: number;
            deepPointCount: number;
            invalidPointCount: number;
            missingRotaryCount: number;
            outOfRangeCount: number;
          };
          warnings?: string[];
        };
        errors: string[];
        warnings: string[];
      };
      rotaryWrapPreviewReport?: {
        schema: string;
        level: "ready" | "review" | "critical";
        summary: string;
        camMode: string;
        coordinateMapping: {
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          rotaryOutputMode: string;
          rotaryWrapPerRevolutionMm: number | null;
          expectedAngleSpanDeg: number | null;
          expectedLinearSpanMm: number | null;
          camoticsInterpretation?: string | null;
        };
        metrics: {
          pointCount: number;
          machineMotionLineCount: number;
          pointAngleSpanDeg: number;
          machineAngleSpanDeg: number;
          machineRotaryLinearSpanMm: number | null;
          pointCoverage: number | null;
          machineCoverage: number | null;
          linearizationErrorMm: number | null;
          linearizationErrorRate: number | null;
        };
        axisRanges?: {
          machineNc?: {
            y?: { min: number | null; max: number | null; span: number; count: number };
            a?: { min: number | null; max: number | null; span: number; count: number };
            z?: { min: number | null; max: number | null; span: number; count: number };
          };
          camoticsPreviewNc?: {
            z?: { min: number | null; max: number | null; span: number; count: number };
          };
        };
        criticalIssues: string[];
        warningIssues: string[];
        requiredActions: string[];
      };
      postprocessTraceReport?: {
        schema: string;
        level: "ready" | "review" | "critical";
        summary: string;
        camMode: string;
        postProcessor: string;
        postProcessorName: string;
        source: {
          pointCount: number;
          toolpathSha256: string;
        };
        machineNc: {
          filename: string;
          cuttingMoveCount: number;
          sha256: string;
        };
        coordinateMapping: {
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          rotaryWrapPerRevolutionMm: number | null;
          rotaryOutputMode: string;
        };
        metrics: {
          compared: number;
          matched: number;
          fitRate: number;
          missingMoves: number;
          extraMoves: number;
          maxAbs: {
            lengthMm: number;
            rotaryMachine: number;
            rotaryDeg: number;
            zMm: number;
          };
        };
        criticalIssues: string[];
        warningIssues: string[];
      };
      controllerDialectReport?: {
        level: "ready" | "review" | "critical";
        summary: string;
        criticalIssues: string[];
        warningIssues: string[];
        dialect: {
          id: string;
          name: string;
          expectedRotaryAxis: string | null;
        };
        programs: Array<{
          filename: string;
          role: string;
          level: string;
          unsupportedCommands: string[];
          unsupportedWords: string[];
        }>;
      };
      camoticsInput?: {
        status: string;
        compatibility: {
          canRunInCamotics: boolean;
          mode: string;
          rotaryAxis: string | null;
          interpretation: string;
          reason: string;
        };
        machine?: {
          postProcessorName: string;
          lengthAxis: string;
          rotaryOutputAxis: string | null;
          rotaryWrapPerRevolutionMm: number | null;
          safeZMm: number;
        };
        stock?: {
          shape: string;
          note: string;
          boundsMm: {
            xMin: number;
            xMax: number;
            yMin: number;
            yMax: number;
            zMin: number;
            zMax: number;
          };
        };
        tool?: {
          toolProfileId?: string | null;
          description: string;
          diameterMm: number;
          flatTipMm?: number | null;
          angleDeg?: number | null;
        };
        limitations?: string[];
      };
      camoticsSimulationPlan?: {
        status: string;
        engine?: {
          execution: string;
          reason: string;
        };
        inputs?: {
          preferredGcode: string;
          machineGcodeForReferenceOnly: string;
          airRun: string;
        };
        coordinateInterpretation?: {
          interpretation: string;
          note: string;
        };
        stock?: {
          shape: string;
          marginMm: number;
        };
        projectTemplate?: {
          schema: string;
        };
      };
      machiningPackageIndex?: {
        packageLevel: string;
        summary: string;
        machineCompatibility?: {
          camMode: string;
          postProcessorName: string;
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          rotaryWrapPerRevolutionMm: number | null;
          intendedMachine?: string | null;
        };
        machineAcceptance?: {
          summary: string;
          requiredStepCount: number;
          blockedStepCount: number;
          artifact: string;
        } | null;
        gates?: {
          allowProductionNc: boolean;
          allowTrialNc: boolean;
          allowAirRun: boolean;
          productionCandidate: string | null;
          trialCandidate: string | null;
          blockers: string[];
          warnings: string[];
          requiredActions: string[];
        };
        recommendedSequence?: string[];
        rotaryWrapPreview?: {
          level: string;
          summary: string;
          machineCoverage: number | null;
          pointCoverage: number | null;
          linearizationErrorRate: number | null;
          artifact: string;
        } | null;
        postprocessTrace?: {
          level: string;
          summary: string;
          fitRate: number | null;
          matched: number | null;
          compared: number | null;
          missingMoves: number | null;
          extraMoves: number | null;
          artifact: string;
        } | null;
        camotics?: {
          status: string;
          previewFile: string;
          resultFile: string | null;
          cliRunPackage?: {
            artifact: string;
            resultTemplate: string | null;
            linuxRunScript: string | null;
            operatorChecklist?: string | null;
            report: string | null;
          } | null;
          compatibility?: {
            canRunInCamotics: boolean;
            interpretation: string;
            reason: string;
          };
          executionPreflight?: {
            artifact: string;
            report: string | null;
            status: string;
            canRunOnCurrentHost: boolean;
            command: string | null;
          } | null;
          inputIdentityStatus?: string | null;
          cliRunPackageBindingStatus?: string | null;
          motionConsistencyStatus?: string | null;
          machineContextStatus?: string | null;
          artifactEvidenceStatus?: string | null;
          limitation: string;
        };
      };
      camoticsCliPackage?: {
        status: string;
        ok: boolean;
        artifact: string;
        resultTemplate: string;
        linuxRunScript: string;
        resultValidator?: string | null;
        operatorChecklist?: string | null;
        report: string;
        productionUnlockEligible: boolean;
        preferredGcodeSha256: string | null;
        motionProfile?: {
          motionLineCount: number;
          zMin: number | null;
          zMax: number | null;
        } | null;
      };
      camoticsExecutionPreflight?: {
        status: string;
        canRunOnCurrentHost: boolean;
        command: string | null;
        artifact: string;
        report: string;
        productionUnlockEligible: boolean;
        nextActions: string[];
      } | null;
      deliveryManifest?: {
        packageLevel: string;
        allowProductionNc: boolean;
        allowTrialNc: boolean;
        allowAirRun: boolean;
        files: Array<{
          filename: string;
          label: string;
          kind: string;
          url: string;
          downloadable: boolean;
          machineUse?: {
            class: string;
            allowedOnMachine: boolean;
            requiresGate: boolean;
            spindleExpected: boolean;
            summary: string;
          };
          note: string;
        }>;
      };
      packageIntegrity?: {
        schema: string;
        status: string;
        summary: string;
        fileCount: number;
        downloadableCount: number;
        missingDownloadableCount: number;
        totalBytes: number;
        files?: Array<{
          filename: string;
          downloadable: boolean;
          exists: boolean;
          sha256: string | null;
          machineUse?: {
            class: string;
            allowedOnMachine: boolean;
          };
        }>;
      };
      operatorRunbook?: {
        schema: string;
        artifact: string;
        summary: string;
      };
      safeTrialExecutionPlan?: {
        schema: string;
        artifact: string;
        stepCount: number;
        activeGate: string;
        allowTrialNc: boolean;
        allowAirRun: boolean;
      };
      productionUnlockMatrix?: {
        schema: string;
        summary: string;
        passCount: number;
        reviewCount: number;
        blockCount: number;
        allowProductionNc: boolean;
      };
      productionEvidenceDossier?: {
        schema: string;
        artifact?: string;
        status: string;
        passedCount: number;
        reviewCount: number;
        blockedCount: number;
        summary: string;
        missingEvidenceCount?: number;
        missingEvidenceTop?: Array<{
          id: string;
          label: string;
          status: "pass" | "review" | "block";
          summary: string;
          evidence: string[];
        }>;
        fieldEvidenceGaps?: Array<{
          id: string;
          label: string;
          status: "pass" | "review" | "block";
          summary: string;
          evidence: string[];
        }>;
        crossChecks?: {
          unlockMatrixPass?: boolean;
          realMaterialRemovalVerified?: boolean;
          camoticsInputIdentityStatus?: string | null;
          camoticsCliRunPackageBindingStatus?: string | null;
          camoticsMotionConsistencyStatus?: string | null;
          camoticsArtifactEvidenceStatus?: string | null;
          camHandoffReady?: boolean;
          neutralSourceBindingStatus?: string | null;
          neutralSourceBindingPass?: boolean;
          ncStaticReady?: boolean;
          controllerDialectReady?: boolean;
          machineAcceptanceRecords?: number;
          latestMachineAcceptanceOutcome?: string | null;
          machineAcceptancePassed?: boolean;
          machineAcceptanceIntegrityBound?: boolean;
          trialFeedbackRecords?: number;
          optimizationStatus?: string | null;
        };
        evidenceItems?: Array<{
          id: string;
          label: string;
          status: "pass" | "review" | "block";
          summary: string;
          evidence: string[];
        }>;
      };
      trialFeedbackTemplate?: {
        schema: string;
        purpose: string;
        issueOptions: string[];
        feedbackFields: {
          outcome: string;
          notes: string;
        };
      };
      trialFeedbackLog?: {
        schema: string;
        artifact: string;
        recordCount: number;
        latestOutcome: MachineFeedback["outcome"];
        latestRecordId: string;
        latestDownloadIntegrityBound?: string | null;
        latestAllRequiredHashesVerified?: boolean;
        recommendations: string[];
      };
      machineAcceptanceLog?: {
        schema: string;
        artifact: string;
        recordCount: number;
        latestOutcome: MachineFeedback["outcome"];
        latestRecordId: string;
        allRequiredPassed: boolean;
        recommendations: string[];
      };
      processOptimizationPlan?: {
        schema: string;
        artifact: string;
        status: string;
        actionCount: number;
        nextRunProfile: {
          mode: string;
          requiresRegeneration: boolean;
          settingsPatch: Partial<ModelSettings>;
        };
      };
      toolSetupSheet?: {
        schema: string;
        summary: string;
        tool: {
          toolProfileId: string | null;
          name: string;
          type: string;
          diameterMm: number;
          angleDeg: number | null;
          flatTipMm: number | null;
        };
        cutting: {
          spindleRpm: number;
          feedRateMmMin: number;
          maxCutDepthMm: number;
          stepoverMm: number;
          stepoverDeg: number;
        };
        checks: Array<{
          id: string;
          status: string;
        }>;
        warnings: string[];
      };
      rotaryCalibrationSheet?: {
        schema: string;
        summary: string;
        mode: string;
        axisMapping: {
          lengthAxis: string;
          depthAxis: string;
          rotaryAxis: string | null;
          rotaryOutputMode: string;
          rotaryWrapPerRevolutionMm: number | null;
          rotaryDegPerLinearMm: number | null;
        };
        warnings: string[];
      };
      machineAcceptanceChecklist?: {
        schema: string;
        packageLevel: string;
        summary: string;
        steps: Array<{
          id: string;
          title: string;
          required: boolean;
          status: string;
          file: string | null;
          expectedEvidence: string;
          blocksProduction: boolean;
        }>;
        unresolvedRisks: string[];
      };
      points: number;
      previewPoints: number;
      estimatedMinutes: number;
      postProcessorName: string;
      warnings: string[];
      simulation?: {
        engine: string;
        mode: string;
        riskLevel: string;
        metrics: {
          missCount: number;
          fitRate: number;
          coverageRate: number;
          maxDepth: number;
          estimatedMinutes: number;
        };
        notes: string[];
        camoticsAdapter?: {
          status: string;
          error: string | null;
          synthetic?: boolean;
          resultArtifact: string | null;
          reportArtifact?: string | null;
          summary?: string | null;
          metrics?: {
            motionLineCount?: number;
            zMin?: number | null;
            zMax?: number | null;
            estimatedMinutes?: number | null;
          };
          evidenceQuality?: {
            productionEvidenceEligible: boolean;
            status: string;
            missing?: string[];
            summary?: string;
            inputIdentity?: {
              cliRunPackage?: {
                status: string;
                required: boolean;
                expectedSha256?: string | null;
                importedSha256?: string | null;
                packageStatus?: string | null;
                message?: string | null;
              };
            };
            machineContext?: {
              status: string;
              message?: string | null;
            };
          } | null;
        };
      };
    };
  };
  error: string | null;
};

type V3JobSummary = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  requestedEngine: string;
  selectedEngine: string | null;
  modelUrl: string;
  createdAt: string;
  updatedAt: string;
  currentStage: string;
  progress: number;
  artifactCount: number;
  latestLog: string;
  resultEngine: string | null;
  fallbackFrom: string | null;
  points: number | null;
  estimatedMinutes: number | null;
  packageLevel: string | null;
  repairStatus: string | null;
  preflightStatus: string | null;
  allowProductionNc: boolean;
  allowTrialNc: boolean;
  allowAirRun: boolean;
  camoticsExecutionPreflight?: {
    artifactExists: boolean;
    status: string | null;
    canRunOnCurrentHost: boolean;
    command: string | null;
    artifact: string | null;
    report: string | null;
    nextActions: string[];
  };
};

type V3Diagnostics = {
  level: "ok" | "warning" | "critical";
  summary: string;
  queue: {
    queued: number;
    running: number;
    concurrency: number;
  };
  checks: Array<{
    id: string;
    level: "ok" | "warning" | "critical";
    value: string | number | boolean;
    detail: string;
  }>;
  recommendedActions: string[];
};

type V3AdapterValidationSummary = {
  id?: string;
  createdAt: string;
  outputRoot: string;
  useNativeCommands: boolean;
  overall: {
    adapterCount: number;
    failed: number;
    generatedPlans: number;
    completedAdapters: number;
    readyForProduction: boolean;
    note?: string;
  };
  nativeReadiness?: {
    mode: string;
    readyCount: number;
    requiredCount: number;
    level: "ready" | "partial" | "missing" | string;
    summary: string;
    blockers: string[];
    nextActions: string[];
    adapters: Array<{
      id: string;
      ready: boolean;
      level: string;
      command: string | null;
      commandMode: string | null;
      missing: string[];
    }>;
  };
  productionGuardrails?: {
    schema: string;
    readyForProduction: boolean;
    summary: string;
    requiredCount: number;
    nextActions: string[];
  } | null;
  handoffClassificationAudit?: {
    schema: string;
    readyForProduction: boolean;
    productionCandidateCount: number;
    unsafeCount: number;
    missingCount: number;
    fixtureCount: number;
    syntheticCount: number;
    previewScaffoldCount: number;
    missingCamProofCount: number;
    camProofReviewCount: number;
    notGeneratedCount: number;
    unboundProductionCandidateCount?: number;
    contactReportBindingCounts?: {
      bound: number;
      missing: number;
      mismatch: number;
      review: number;
      notChecked: number;
      other: number;
    };
    summary: string;
    nextActions: string[];
    adapters: Array<{
      id: string;
      classification: string;
      outputKind: string | null;
      productionCandidate: boolean;
      fixture: boolean;
      synthetic: boolean;
      previewScaffold: boolean;
      missingCamProof?: boolean;
      camProofReview?: boolean;
      notGenerated: boolean;
      unsafe: boolean;
      generatedByExternalCommand: boolean;
      contactReport?: {
        status: string;
        productionCandidate: boolean;
        inputBindingStatus: string;
        reportSchema?: string | null;
        summary?: string | null;
      } | null;
    }>;
  } | null;
  adapters: Array<{
    id: string;
    name: string;
    command: string;
    plan: {
      generated: boolean;
      path?: string | null;
    };
    report?: {
      status?: string;
      error?: string | null;
    };
    run?: {
      status?: number | null;
      exitCode?: number | null;
      error?: string | null;
      durationMs?: number | null;
    };
    handoffClassification?: string;
    productionCandidate?: boolean;
    contactReport?: {
      status: string;
      productionCandidate: boolean;
      inputBindingStatus: string;
      reportSchema?: string | null;
      summary?: string | null;
    } | null;
  }>;
  apiArtifacts?: {
    json?: string;
    markdown?: string;
    runbook?: string;
    linuxEvidence?: string;
  };
};

type V3NativeCamCapability = {
  category: string;
  integrationRole: string;
  inputFormats?: string[];
  outputFormats: string[];
  supportedWorkflows: string[];
  bestFor?: string[];
  notEnoughFor?: string[];
  projectUse?: string | null;
  productionGate: string;
};

type V3NativeCamCapabilityMatrixItem = {
  id: string;
  name: string;
  level: string;
  ready: boolean;
  category: string;
  integrationRole: string;
  supportedWorkflows: string[];
  outputFormats: string[];
  productionGate: string;
};

type V3NativeCamExecutionPlan = {
  schema?: string | null;
  summary?: string | null;
  strategy?: string | null;
  readyStages: number;
  totalStages: number;
  stages: Array<{
    id: string;
    order: number;
    title: string;
    engineId: string;
    phase: string;
    priority: string;
    status: string;
    engineReady: boolean;
    engineLevel: string;
    input: string;
    output: string;
    acceptance: string;
    handoff: string;
    productionBoundary: string;
  }>;
  globalAcceptanceCommands: string[];
  productionLocks: string[];
};

type V3NativeCamReadinessSummary = {
  id: string;
  schema: string;
  createdAt: string;
  host?: {
    platform?: string;
    arch?: string;
    hostname?: string;
    node?: string;
  } | null;
  summary: {
    readyCount: number;
    requiredCount: number;
    level: string;
    text: string;
    capabilityMatrix?: V3NativeCamCapabilityMatrixItem[];
    executionPlan?: V3NativeCamExecutionPlan | null;
    blockers: string[];
    nextActions: string[];
  };
  checks: Array<{
    id: string;
    name: string;
    role: string;
    level: string;
    ready: boolean;
    capabilities?: V3NativeCamCapability | null;
    command: string | null;
    version: string | null;
    missing: string[];
  }>;
  apiArtifacts?: {
    json?: string;
    markdown?: string;
    bootstrap?: string;
    envTemplate?: string;
    checklist?: string;
    realOutputCheck?: string;
    packageManifest?: string;
    packageZip?: string;
  };
  packageArtifacts?: {
    schema?: string | null;
    files: Array<{
      filename: string;
      role: string;
      description: string;
      url: string;
    }>;
    commands: string[];
  } | null;
};

type V3ReadinessSummary = {
  id: string;
  schema: string;
  createdAt: string;
  level: "production-ready" | "trial-only" | "blocked" | string;
  summary: string;
  gates: {
    allowProductionNc: boolean;
    allowTrialNc: boolean;
    allowAirRun: boolean;
    blockers: string[];
    warnings: string[];
    nextActions: string[];
  };
  acceptancePlan?: {
    schema: string;
    level: string;
    completed: number;
    total: number;
    nextStep: null | {
      order: number;
      id: string;
      title: string;
      status: string;
      command: string | null;
      evidence: string[];
      detail: string;
      blocksProduction: boolean;
    };
    steps: Array<{
      order: number;
      id: string;
      title: string;
      status: string;
      command: string | null;
      evidence: string[];
      detail: string;
      blocksProduction: boolean;
    }>;
  };
  goalAudit?: {
    schema: string;
    status: string;
    productionAllowed: boolean;
    trialOnly: boolean;
    readyLayerCount: number;
    partialLayerCount: number;
    blockedLayerCount: number;
    worstLayer: null | {
      id: string;
      status: string;
      title: string;
    };
    layers: Array<{
      id: string;
      title: string;
      status: string;
      missing: string[];
      nextActions: string[];
    }>;
    keepHiddenOrDeferred: string[];
    nextBestActions: string[];
  } | null;
  diagnostics: {
    level: string;
    summary: string | null;
  };
  nativeCam: {
    level: string;
    readyCount: number;
    requiredCount: number;
    serverPackage?: {
      schema?: string | null;
      files: Array<{
        filename: string;
        role: string;
        url?: string | null;
      }>;
      commands: string[];
    } | null;
  } | null;
  camServerConfig: {
    schema: string;
    status: string;
    selectedEngine: string;
    selectedEngineName: string;
    nativeCamLevel: string;
    missingRequired: string[];
    deploymentValidation?: V3CamServerDeploymentValidation | null;
  } | null;
  adapterValidation: {
    failed: number;
    generatedPlans: number;
    completedAdapters: number;
    readyForProduction: boolean;
    handoffClassificationAudit?: {
      productionCandidateCount: number;
      unsafeCount: number;
      missingCount: number;
      missingCamProofCount?: number;
      camProofReviewCount?: number;
      notGeneratedCount: number;
      summary: string;
    } | null;
  } | null;
  nativeCamRealOutputAcceptance: {
    id: string;
    schema: string;
    createdAt: string | null;
    level: string;
    summary: string;
    productionCandidateCount: number;
    unsafeCount: number;
    missingCount: number;
    sourceReportBindingStatus?: string;
    sourceReportBindingRequired?: boolean;
    sourceReportBindingSummary?: string;
    sourceReportSha256?: string | null;
    targetMachineBoundaryStatus?: {
      schema?: string;
      status: string;
      matched?: boolean;
      summary?: string;
      mismatches?: string[];
    } | null;
    targetMachineBoundary?: {
      schema?: string;
      controllerClass?: string | null;
      machineProfileId?: string | null;
      camMode?: string | null;
      postProcessor?: string | null;
      rotaryOutputAxis?: string | null;
      toolProfileId?: string | null;
    } | null;
    blockers: string[];
    warnings: string[];
    nextActions: string[];
    adapters: Array<{
      id: string;
      status: string | null;
      classification: string;
      productionCandidate: boolean;
      fixture: boolean;
      synthetic: boolean;
      previewScaffold: boolean;
      generatedByExternalCommand: boolean;
    }>;
  } | null;
  runbookResult: {
    schema: string;
    readinessReportId?: string | null;
    createdAt: string | null;
    ok: boolean;
    exitCode: number | null;
    failedCount: number;
    blockingFailedCount?: number;
    productionSafe?: boolean;
    identityValid?: boolean;
    linuxEvidence?: {
      status?: string;
      foundCount?: number;
      requiredFoundCount?: number;
      missingRequired?: string[];
      evidenceChain?: {
        status?: string;
        openCamLib?: {
          realCandidateKnown?: boolean;
          realCandidateReady?: boolean;
          productionLocked?: boolean;
          firstBlocking?: string | null;
          contactPathCoverage?: {
            status?: string;
            ready?: boolean;
            summary?: string | null;
          } | null;
          protectedZones?: {
            status?: string;
            ready?: boolean;
            summary?: string | null;
          } | null;
          protectedZonesReady?: boolean;
          candidatePackageLevel?: string;
          candidatePackageReadyForImport?: boolean;
          candidatePackageBlockedReason?: string | null;
          candidateMachineFit?: {
            level?: string;
            summary?: string | null;
            targetMachine?: {
              controllerClass?: string | null;
              rotaryOutputAxis?: string | null;
              wrapPerRevolutionMm?: number | null;
              toolProfileId?: string | null;
            } | null;
            coverage?: {
              pointCount?: number;
              rotarySpanDeg?: number | null;
              expectedRotaryCoverageDeg?: number | null;
              rotaryCoverageRatio?: number | null;
              depthMax?: number | null;
            } | null;
            riskCounts?: {
              holdZonePointCount?: number;
              deepPointCount?: number;
              invalidPointCount?: number;
              missingRotaryCount?: number;
            } | null;
          } | null;
          candidatePackageStep?: string;
          candidatePackage?: {
            filename?: string;
            exists?: boolean;
            level?: string | null;
            status?: string | null;
            sha256?: string | null;
          } | null;
        };
        camotics?: {
          productionEvidenceEligible?: boolean;
          upstreamEvidenceRequired?: boolean;
          upstreamEvidenceStatus?: string;
          upstreamEvidence?: {
            required?: boolean;
            status?: string;
            source?: string;
            expectedCount?: number;
            importedCount?: number;
            matchedCount?: number;
            mismatchCount?: number;
            candidatePackageValidationBound?: boolean;
            candidatePackageBundleBound?: boolean;
            files?: Array<{
              key?: string | null;
              filename?: string | null;
              matched?: boolean;
              expectedSha256?: string | null;
              importedSha256?: string | null;
            }>;
          } | null;
        };
        crossChecks?: {
          candidatePackageStep?: string;
        };
      } | null;
      files?: Array<{
        filename?: string;
        status?: string;
      }>;
    };
    failedSteps: Array<{
      id: string;
      title: string;
      exitCode: number | null;
      blocksProduction: boolean;
    }>;
    stepCount: number;
    levelAtReport: string | null;
    acceptanceAtReport: string | null;
    artifactPath: string;
  } | null;
  externalHandoff: V3ExternalHandoffSummary | null;
  externalCamHandoffs: {
    schema: string;
    requiredEngines: string[];
    completedEngines: string[];
    byEngine: Record<string, V3ExternalHandoffSummary | undefined>;
    latest: V3ExternalHandoffSummary[];
  } | null;
  neutralImport: {
    id: string;
    schema: string;
    createdAt: string | null;
    ok: boolean;
    status: string | null;
    imported: boolean;
    synthetic: boolean;
    pointCount: number | null;
    postprocessEligible: boolean;
    sourceBindingStatus?: string | null;
    sourceBindingSummary?: string | null;
    adapterReport: string | null;
    neutralToolpath: string | null;
    outputRoot: string | null;
  } | null;
  postprocessHandoffReadiness: {
    schema: string;
    status: "ready" | "review" | "pending" | "blocked" | string;
    summary: string;
    required: boolean;
    source: string;
    productionCamEvidence: string;
    neutralImportId: string | null;
    pointCount: number;
    sourceBindingStatus?: string | null;
    nextActions: string[];
  } | null;
  camoticsImport: {
    id: string;
    schema: string;
    createdAt: string | null;
    ok: boolean;
    status: string | null;
    synthetic: boolean;
    riskLevel: string | null;
    materialRemovedMm3: number | null;
    productionEvidenceEligible: boolean;
    inputIdentityStatus?: string | null;
    cliRunPackageBindingStatus?: string | null;
    motionConsistencyStatus?: string | null;
    machineContextStatus?: string | null;
    evidenceQualityStatus?: string | null;
    adapterReport: string | null;
    camoticsResult: string | null;
    outputRoot: string | null;
  } | null;
  readinessCamoticsEvidence: {
    schema: string;
    source: string;
    id: string | null;
    jobId: string | null;
    ok: boolean;
    status: string | null;
    synthetic: boolean | null;
    riskLevel: string | null;
    productionEvidenceEligible: boolean;
    realMaterialRemovalVerified: boolean;
    inputIdentityStatus: string;
    cliRunPackageBindingStatus: string;
    motionConsistencyStatus: string;
    machineContextStatus: string;
    artifactEvidenceStatus: string;
    summary: string;
  } | null;
  latestJob: V3JobSummary | null;
  latestTrialFeedback: {
    schema: string;
    jobId: string;
    updatedAt: string | null;
    recordCount: number;
    latestRecordId: string | null;
    latestOutcome: MachineFeedback["outcome"] | string | null;
    latestIssues: string[];
    latestDownloadIntegrityBound?: string | null;
    latestAllRequiredHashesVerified?: boolean;
    artifact: string;
  } | null;
  latestMachineAcceptance: {
    schema: string;
    jobId: string;
    updatedAt: string | null;
    recordCount: number;
    latestRecordId: string | null;
    latestOutcome: MachineFeedback["outcome"] | string | null;
    latestAllRequiredPassed: boolean;
    artifact: string;
  } | null;
  apiArtifacts?: {
    json?: string;
    markdown?: string;
    runbook?: string;
    camServerConfig?: string;
    linuxEvidence?: string;
  };
};

type V3CamServerDeploymentValidation = {
  schema: string;
  camMode: string;
  requiredAdapters: string[];
  fixtureOrSyntheticMustBeOff: string[];
  productionUnlockRequires: string[];
  stages: Array<{
    id: string;
    title: string;
    command: string;
    expectedArtifacts: string[];
    blocksProduction: boolean;
  }>;
  forbiddenProductionEnv?: string[];
};

type V3ExternalHandoffSummary = {
    id: string;
    status: string;
    updatedAt: string;
    selectedEngine: string | null;
    resultEngine: string | null;
    source: string | null;
    simulationEngine: string | null;
    simulationStatus: string | null;
    syntheticSimulation: boolean;
    points: number | null;
    postProcessorName: string | null;
    packageLevel: string | null;
    artifacts?: {
      adapterReport?: string;
      neutralToolpath?: string;
      camoticsResult?: string;
      simulationSummary?: string;
      toolpath?: string;
    };
};

type TaskSnapshot = {
  id: string;
  label: string;
  detail: string;
  settings: ModelSettings;
  sourceLabel: string;
  createdAt: string;
};

type MachineFeedback = {
  id: string;
  createdAt: string;
  outcome: "success" | "review" | "failed";
  sourceLabel: string;
  machineName: string;
  toolName: string;
  materialName: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  costEstimateRange: string | null;
  issues: string[];
  notes: string;
  photoName: string | null;
  photoUrl: string | null;
  settings: ModelSettings;
};

type FeedbackDraft = {
  outcome: MachineFeedback["outcome"];
  actualMinutes: string;
  notes: string;
  issues: string[];
  photoName: string | null;
  photoUrl: string | null;
};

type CostCalibrationReport = {
  sampleCount: number;
  averageRatio: number;
  averageErrorRate: number;
  calibratedTotalMinutes: number;
  calibratedCostLow: number;
  calibratedCostHigh: number;
  confidence: "none" | "low" | "medium" | "high";
  matchedSamples: MachineFeedback[];
};

type ProjectProfile = {
  projectName: string;
  customerName: string;
  projectCode: string;
  role: UserRole;
};

type DeploymentMode = "local-only" | "lan-proxy" | "cloud-hybrid";
type DeploymentProfile = {
  mode: DeploymentMode;
  apiKeyLocation: "server-env" | "browser-local" | "not-configured";
  assetStorage: "browser-cache" | "lan-server" | "cloud-bucket";
  computeTarget: "browser" | "lan-server" | "cloud-worker";
  meshCachePath: string;
  lanBaseUrl: string;
  cloudBaseUrl: string;
  allowExternalAssetLinks: boolean;
};

type ProjectArchive = {
  id: string;
  createdAt: string;
  projectName: string;
  customerName: string;
  projectCode: string;
  sourceLabel: string;
  machineName: string;
  toolName: string;
  materialName: string;
  hasToolpath: boolean;
  exportReady: boolean;
  feedbackCount: number;
};

type CaptureGuideSlot = {
  label: string;
  angleDeg: number;
  imageName: string | null;
  score: number | null;
  status: "ready" | "usable" | "retake" | "missing";
  hint: string;
  issue: string;
  retakeAction: string;
};

type CaptureGuideReport = {
  score: number;
  verdict: "ready" | "usable" | "retake";
  summary: string;
  slots: CaptureGuideSlot[];
  suggestions: string[];
};

type ExportGateState = {
  safetyReportReviewed: boolean;
  airRunVerified: boolean;
  fixtureConfirmed: boolean;
};

type SafetyGateStatus = {
  level: "blocked" | "repair" | "air-run" | "trial";
  title: string;
  detail: string;
  canDownloadProduction: boolean;
};

type V3EvidenceLoopItem = {
  id: string;
  title: string;
  level: "ok" | "warning" | "critical";
  value: string;
  detail: string;
};

type V3EvidenceLoopSummary = {
  level: "ok" | "warning" | "critical";
  title: string;
  detail: string;
  items: V3EvidenceLoopItem[];
  nextActions: string[];
};

type V3TrialWorkflowStep = {
  id: string;
  title: string;
  status: "done" | "active" | "locked" | "review";
  detail: string;
};

type MachineAcceptanceStep = "airRun" | "softTrial" | "formalTrial";
type MachineAcceptanceRecord = {
  machineId: string;
  machineName: string;
  controller: MachineProfile["controller"];
  updatedAt: string;
  airRun: boolean;
  airRunAt: string | null;
  softTrial: boolean;
  softTrialAt: string | null;
  formalTrial: boolean;
  formalTrialAt: string | null;
  notes: string;
};

const toolpathColors = {
  rough: 0xd2451e,
  finish: 0x8b5cf6,
  rest: 0xf59e0b,
  simulation: 0x00a676
};

const V3_TRIAL_FOCUSED_UI = true;

const workflowStages: Array<{ id: WorkflowStage; label: string; hint: string }> = [
  ...(!V3_TRIAL_FOCUSED_UI ? [{ id: "project" as const, label: "项目", hint: "客户/权限" }] : []),
  { id: "source", label: "素材", hint: "上传/载入" },
  { id: "model", label: "建模", hint: "3D/Meshy" },
  { id: "process", label: "工艺", hint: "刀具/机床" },
  { id: "cam", label: "刀路", hint: "生成/下载" }
];

const CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY = "hediao3d.customProcessTemplates.v1";
const MACHINE_FEEDBACK_STORAGE_KEY = "hediao3d.machineFeedback.v1";
const PROJECT_PROFILE_STORAGE_KEY = "hediao3d.projectProfile.v1";
const PROJECT_ARCHIVE_STORAGE_KEY = "hediao3d.projectArchive.v1";
const DEPLOYMENT_PROFILE_STORAGE_KEY = "hediao3d.deploymentProfile.v1";
const MACHINE_ACCEPTANCE_STORAGE_KEY = "hediao3d.machineAcceptance.v1";
const defaultProjectProfile: ProjectProfile = {
  projectName: "核雕试雕项目",
  customerName: "默认客户",
  projectCode: "HD3D-V2",
  role: "process"
};
const defaultDeploymentProfile: DeploymentProfile = {
  mode: "lan-proxy",
  apiKeyLocation: "server-env",
  assetStorage: "lan-server",
  computeTarget: "lan-server",
  meshCachePath: "./data/hediao3d-cache",
  lanBaseUrl: "http://192.168.1.10:5174",
  cloudBaseUrl: "",
  allowExternalAssetLinks: false
};
const defaultFeedbackDraft: FeedbackDraft = {
  outcome: "success",
  actualMinutes: "",
  notes: "",
  issues: [],
  photoName: null,
  photoUrl: null
};
const feedbackIssueOptions = ["过切", "欠切", "毛刺", "断刀", "端部残料", "夹持痕迹", "纹理丢失", "A轴错位"];

function loadCustomProcessTemplates(): ProcessTemplate[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProcessTemplate).slice(0, 16);
  } catch {
    return [];
  }
}

function loadMachineFeedback(): MachineFeedback[] {
  try {
    const raw = window.localStorage.getItem(MACHINE_FEEDBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMachineFeedback).slice(0, 40);
  } catch {
    return [];
  }
}

function loadProjectProfile(): ProjectProfile {
  try {
    const raw = window.localStorage.getItem(PROJECT_PROFILE_STORAGE_KEY);
    if (!raw) return defaultProjectProfile;
    const parsed = JSON.parse(raw);
    return isProjectProfile(parsed) ? parsed : defaultProjectProfile;
  } catch {
    return defaultProjectProfile;
  }
}

function loadProjectArchives(): ProjectArchive[] {
  try {
    const raw = window.localStorage.getItem(PROJECT_ARCHIVE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProjectArchive).slice(0, 30);
  } catch {
    return [];
  }
}

function loadDeploymentProfile(): DeploymentProfile {
  try {
    const raw = window.localStorage.getItem(DEPLOYMENT_PROFILE_STORAGE_KEY);
    if (!raw) return defaultDeploymentProfile;
    const parsed = JSON.parse(raw);
    return isDeploymentProfile(parsed) ? parsed : defaultDeploymentProfile;
  } catch {
    return defaultDeploymentProfile;
  }
}

function loadMachineAcceptanceRecords(): MachineAcceptanceRecord[] {
  try {
    const raw = window.localStorage.getItem(MACHINE_ACCEPTANCE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMachineAcceptanceRecord).slice(0, 32);
  } catch {
    return [];
  }
}

function isProcessTemplate(value: unknown): value is ProcessTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Partial<ProcessTemplate>;
  return (
    typeof template.id === "string" &&
    typeof template.name === "string" &&
    typeof template.intent === "string" &&
    typeof template.toolProfileId === "string" &&
    typeof template.materialProfileId === "string" &&
    typeof template.maxCutDepth === "number" &&
    typeof template.stockAllowance === "number" &&
    typeof template.stepoverMm === "number" &&
    typeof template.stepoverDeg === "number" &&
    typeof template.feedRate === "number" &&
    typeof template.spindleRpm === "number" &&
    typeof template.finishingStrategy === "string" &&
    typeof template.notes === "string"
  );
}

function isMachineFeedback(value: unknown): value is MachineFeedback {
  if (!value || typeof value !== "object") return false;
  const feedback = value as Partial<MachineFeedback>;
  return (
    typeof feedback.id === "string" &&
    typeof feedback.createdAt === "string" &&
    (feedback.outcome === "success" || feedback.outcome === "review" || feedback.outcome === "failed") &&
    typeof feedback.sourceLabel === "string" &&
    typeof feedback.machineName === "string" &&
    typeof feedback.toolName === "string" &&
    typeof feedback.materialName === "string" &&
    Array.isArray(feedback.issues) &&
    typeof feedback.notes === "string" &&
    Boolean(feedback.settings)
  );
}

function isProjectProfile(value: unknown): value is ProjectProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ProjectProfile>;
  return (
    typeof profile.projectName === "string" &&
    typeof profile.customerName === "string" &&
    typeof profile.projectCode === "string" &&
    isUserRole(profile.role)
  );
}

function isProjectArchive(value: unknown): value is ProjectArchive {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectArchive>;
  return (
    typeof item.id === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.projectName === "string" &&
    typeof item.customerName === "string" &&
    typeof item.projectCode === "string" &&
    typeof item.sourceLabel === "string" &&
    typeof item.machineName === "string" &&
    typeof item.toolName === "string" &&
    typeof item.materialName === "string" &&
    typeof item.hasToolpath === "boolean" &&
    typeof item.exportReady === "boolean" &&
    typeof item.feedbackCount === "number"
  );
}

function isDeploymentProfile(value: unknown): value is DeploymentProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<DeploymentProfile>;
  return (
    isDeploymentMode(profile.mode) &&
    (profile.apiKeyLocation === "server-env" || profile.apiKeyLocation === "browser-local" || profile.apiKeyLocation === "not-configured") &&
    (profile.assetStorage === "browser-cache" || profile.assetStorage === "lan-server" || profile.assetStorage === "cloud-bucket") &&
    (profile.computeTarget === "browser" || profile.computeTarget === "lan-server" || profile.computeTarget === "cloud-worker") &&
    typeof profile.meshCachePath === "string" &&
    typeof profile.lanBaseUrl === "string" &&
    typeof profile.cloudBaseUrl === "string" &&
    typeof profile.allowExternalAssetLinks === "boolean"
  );
}

function isDeploymentMode(mode: unknown): mode is DeploymentMode {
  return mode === "local-only" || mode === "lan-proxy" || mode === "cloud-hybrid";
}

function isMachineAcceptanceRecord(value: unknown): value is MachineAcceptanceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MachineAcceptanceRecord>;
  return (
    typeof record.machineId === "string" &&
    typeof record.machineName === "string" &&
    (record.controller === "generic" || record.controller === "weihong" || record.controller === "syntec") &&
    typeof record.updatedAt === "string" &&
    typeof record.airRun === "boolean" &&
    typeof record.softTrial === "boolean" &&
    typeof record.formalTrial === "boolean" &&
    typeof record.notes === "string"
  );
}

function isUserRole(role: unknown): role is UserRole {
  return role === "designer" || role === "process" || role === "operator" || role === "admin";
}

export function App() {
  const [images, setImages] = useState<CarvingImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [activeStage, setActiveStage] = useState<WorkflowStage>(V3_TRIAL_FOCUSED_UI ? "source" : "project");
  const [modelSubStage, setModelSubStage] = useState<ModelSubStage>(V3_TRIAL_FOCUSED_UI ? "ai" : "local");
  const [wireframe, setWireframe] = useState(false);
  const [toolpath, setToolpath] = useState<GeneratedToolpath | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [generatedDepth, setGeneratedDepth] = useState<DepthMap | null>(null);
  const [generationLabel, setGenerationLabel] = useState("内置示例");
  const [aiMeshUrl, setAiMeshUrl] = useState<string | null>(null);
  const [aiMeshStlUrl, setAiMeshStlUrl] = useState<string | null>(null);
  const [originalModelFileName, setOriginalModelFileName] = useState<string | null>(null);
  const [aiMeshStatus, setAiMeshStatus] = useState("未生成");
  const [aiProviderId, setAiProviderId] = useState<Ai3dProviderId>("meshy");
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isMeshRepairing, setIsMeshRepairing] = useState(false);
  const [isToolpathGenerating, setIsToolpathGenerating] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("model");
  const [toolpathKind, setToolpathKind] = useState<ToolpathKind>("rough");
  const [meshQuality, setMeshQuality] = useState<MeshQualityReport | null>(null);
  const [meshQualityStatus, setMeshQualityStatus] = useState("等待 STL 模型");
  const [v3Engines, setV3Engines] = useState<V3EngineStatus[]>([]);
  const [v3Job, setV3Job] = useState<V3OrchestratorJob | null>(null);
  const [v3JobHistory, setV3JobHistory] = useState<V3JobSummary[]>([]);
  const [v3Diagnostics, setV3Diagnostics] = useState<V3Diagnostics | null>(null);
  const [v3AdapterValidation, setV3AdapterValidation] = useState<V3AdapterValidationSummary | null>(null);
  const [v3NativeCamReadiness, setV3NativeCamReadiness] = useState<V3NativeCamReadinessSummary | null>(null);
  const [v3Readiness, setV3Readiness] = useState<V3ReadinessSummary | null>(null);
  const [isV3JobRunning, setIsV3JobRunning] = useState(false);
  const [isV3PackageDownloading, setIsV3PackageDownloading] = useState(false);
  const [isV3AdapterValidating, setIsV3AdapterValidating] = useState(false);
  const [isV3NativeCamChecking, setIsV3NativeCamChecking] = useState(false);
  const [isV3NativeCamAcceptanceImporting, setIsV3NativeCamAcceptanceImporting] = useState(false);
  const [isV3ReadinessChecking, setIsV3ReadinessChecking] = useState(false);
  const [isV3RunbookResultImporting, setIsV3RunbookResultImporting] = useState(false);
  const [isV3MachineAcceptanceSyncing, setIsV3MachineAcceptanceSyncing] = useState(false);
  const [isV3CamoticsImporting, setIsV3CamoticsImporting] = useState(false);
  const [isV3LinuxCamJobValidationImporting, setIsV3LinuxCamJobValidationImporting] = useState(false);
  const [isV3CamoticsPackagePreparing, setIsV3CamoticsPackagePreparing] = useState(false);
  const [v3CamoticsResultFile, setV3CamoticsResultFile] = useState<File | null>(null);
  const [v3CamoticsResultZipFile, setV3CamoticsResultZipFile] = useState<File | null>(null);
  const [v3CamoticsScreenshotFile, setV3CamoticsScreenshotFile] = useState<File | null>(null);
  const [v3CamoticsMaterialMeshFile, setV3CamoticsMaterialMeshFile] = useState<File | null>(null);
  const [v3LinuxCamJobValidationFile, setV3LinuxCamJobValidationFile] = useState<File | null>(null);
  const [v3NativeCamAcceptanceFile, setV3NativeCamAcceptanceFile] = useState<File | null>(null);
  const [v3NativeCamAcceptanceZipFile, setV3NativeCamAcceptanceZipFile] = useState<File | null>(null);
  const [v3RunbookResultFile, setV3RunbookResultFile] = useState<File | null>(null);
  const [v3RunbookResultZipFile, setV3RunbookResultZipFile] = useState<File | null>(null);
  const [v3Status, setV3Status] = useState("等待引擎探测");
  const [v3UserNotice, setV3UserNotice] = useState<{ level: "ok" | "warning" | "error" | "info"; title: string; detail: string } | null>(null);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [taskJobs, setTaskJobs] = useState<TaskJob[]>([]);
  const [selectedTaskJobId, setSelectedTaskJobId] = useState<string | null>(null);
  const [taskSnapshots, setTaskSnapshots] = useState<TaskSnapshot[]>([]);
  const [customProcessTemplates, setCustomProcessTemplates] = useState<ProcessTemplate[]>(loadCustomProcessTemplates);
  const [machineFeedback, setMachineFeedback] = useState<MachineFeedback[]>(loadMachineFeedback);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>(defaultFeedbackDraft);
  const [projectProfile, setProjectProfile] = useState<ProjectProfile>(loadProjectProfile);
  const [projectArchives, setProjectArchives] = useState<ProjectArchive[]>(loadProjectArchives);
  const [deploymentProfile, setDeploymentProfile] = useState<DeploymentProfile>(loadDeploymentProfile);
  const [machineAcceptanceRecords, setMachineAcceptanceRecords] = useState<MachineAcceptanceRecord[]>(loadMachineAcceptanceRecords);
  const [exportGate, setExportGate] = useState<ExportGateState>({
    safetyReportReviewed: false,
    airRunVerified: false,
    fixtureConfirmed: false
  });
  const canceledTaskJobIdsRef = useRef<Set<string>>(new Set());
  const processTemplateImportRef = useRef<HTMLInputElement | null>(null);
  const toolpathImportRef = useRef<HTMLInputElement | null>(null);
  const originalModelImportRef = useRef<HTMLInputElement | null>(null);
  const importedModelObjectUrlRef = useRef<string | null>(null);

  const releaseImportedModelObjectUrl = () => {
    if (!importedModelObjectUrlRef.current) return;
    URL.revokeObjectURL(importedModelObjectUrlRef.current);
    importedModelObjectUrlRef.current = null;
  };

  const activeImage = images.find((image) => image.id === activeId) ?? images[0];
  const sourceDepth = generatedDepth ?? createBlankDepthMap();
  const processedDepth = useMemo(
    () => processDepthMap(sourceDepth, settings.contrast, settings.invertDepth, settings.smoothPasses),
    [sourceDepth, settings.contrast, settings.invertDepth, settings.smoothPasses]
  );
  const geometry = useMemo(() => createReliefGeometry(processedDepth, settings), [processedDepth, settings]);
  const isMultiviewGenerated = generationLabel.startsWith("本地360°环绕浮雕");
  const envelopeQuality = useMemo(() => (toolpath ? analyzeEnvelopeQuality(toolpath, settings) : null), [toolpath, settings]);
  const envelopeHeatmapDiagnosis = useMemo(
    () => (toolpath && envelopeQuality ? createEnvelopeHeatmapDiagnosis(toolpath, settings, envelopeQuality) : null),
    [toolpath, settings, envelopeQuality]
  );
  const selectedTool = useMemo(() => getToolProfile(settings.toolProfileId), [settings.toolProfileId]);
  const selectedMaterial = useMemo(() => getMaterialProfile(settings.materialProfileId), [settings.materialProfileId]);
  const selectedMachine = useMemo(() => getMachineProfile(settings.machineProfileId), [settings.machineProfileId]);
  const selectedAiProvider = useMemo(() => getAi3dProvider(aiProviderId), [aiProviderId]);
  const visibleAiProviders = useMemo(
    () => V3_TRIAL_FOCUSED_UI ? ai3dProviders.filter((provider) => provider.status === "available") : ai3dProviders,
    []
  );
  const allProcessTemplates = useMemo(
    () => [...processTemplates, ...customProcessTemplates],
    [customProcessTemplates]
  );
  const safetyIssues = useMemo(() => [...validateManufacturingSetup(settings, toolpath), ...validateGcodeProgram(settings, toolpath)], [settings, toolpath]);
  const exportBlocked = hasCriticalIssue(safetyIssues);
  const safetyGateStatus = useMemo(() => createSafetyGateStatus(toolpath, safetyIssues, exportGate), [toolpath, safetyIssues, exportGate]);
  const exportGateReady = safetyGateStatus.canDownloadProduction;
  const isOperatorMode = projectProfile.role === "operator";
  const canDownloadProduction = !isOperatorMode || exportGateReady;
  const v3ProductionGate = v3Job?.result?.summary.productionGate ?? null;
  const v3ProductionDownloadLocked = Boolean(v3ProductionGate && !v3ProductionGate.allowProductionNc);
  const formalDownloadAllowed = exportGateReady && canDownloadProduction && !v3ProductionDownloadLocked;
  const productionDownloadTitle = getProductionDownloadTitle(isOperatorMode, exportBlocked, exportGateReady, v3ProductionGate);
  const activeQuality = activeImage?.quality;
  const captureGuide = useMemo(() => createCaptureGuideReport(images), [images]);
  const manufacturingQuality = useMemo(
    () => createManufacturingQualityReport(settings, toolpath, safetyIssues, envelopeQuality),
    [settings, toolpath, safetyIssues, envelopeQuality]
  );
  const materialRemoval = useMemo(() => analyzeMaterialRemoval(settings, toolpath), [settings, toolpath]);
  const meshCalibrationGuide = useMemo(() => (meshQuality ? createMeshCalibrationGuide(meshQuality, settings) : null), [meshQuality, settings]);
  const costEstimate = useMemo(
    () => createCostEstimate(settings, toolpath, selectedTool, selectedMaterial, selectedMachine),
    [settings, toolpath, selectedTool, selectedMaterial, selectedMachine]
  );
  const costCalibration = useMemo(
    () => createCostCalibrationReport(costEstimate, machineFeedback, selectedMachine.name, selectedTool.name),
    [costEstimate, machineFeedback, selectedMachine.name, selectedTool.name]
  );
  const deploymentReadiness = useMemo(() => createDeploymentReadiness(deploymentProfile), [deploymentProfile]);
  const selectedMachineAcceptance = useMemo(
    () => getMachineAcceptanceRecord(machineAcceptanceRecords, selectedMachine),
    [machineAcceptanceRecords, selectedMachine]
  );
  const machineAcceptanceStatus = useMemo(() => createMachineAcceptanceStatus(selectedMachineAcceptance), [selectedMachineAcceptance]);
  const airRunProgram = useMemo(
    () => (toolpath ? toolpath.programs?.airRun ?? createAirRunProgram(toolpath.programs?.combined?.points ?? toolpath.points, settings, toolpath.estimatedMinutes) : null),
    [settings, toolpath]
  );
  const selectedToolpathProgram = useMemo(() => {
    if (!toolpath) return null;
    return getToolpathProgram(toolpath, toolpathKind);
  }, [toolpath, toolpathKind]);
  const v3DeliveryShortcutFiles = useMemo(() => {
    const files = v3Job?.result?.summary.deliveryManifest?.files ?? [];
    const byName = new Map(files.map((file) => [file.filename, file]));
    return [
      byName.get("machining-package-index.json"),
      byName.get("next-action-checklist.md"),
      byName.get("linux-cam-closed-loop-handoff.md"),
      byName.get("operator-runbook.md"),
      byName.get("operator-download-checklist.md"),
      byName.get("safe-trial-execution-plan.json"),
      byName.get("rotary-calibration-airrun.nc"),
      byName.get("air-run.nc"),
      byName.get("cam-handoff-evidence.md"),
      byName.get("open-source-cam-execution-plan.json")
    ].filter((file): file is NonNullable<typeof file> => Boolean(file));
  }, [v3Job]);
  const v3SafeTrialPlanFile = useMemo(
    () => findV3DeliveryFile(v3Job, "safe-trial-execution-plan.json"),
    [v3Job]
  );
  const v3ClosedLoopHandoffFile = useMemo(
    () => findV3DeliveryFile(v3Job, "linux-cam-closed-loop-handoff.md"),
    [v3Job]
  );
  const v3AirRunFile = useMemo(
    () => findV3DeliveryFile(v3Job, "air-run.nc"),
    [v3Job]
  );
  const v3OperatorPackageFile = useMemo(
    () => findV3DeliveryFile(v3Job, "operator-runbook.md") ?? findV3DeliveryFile(v3Job, "operator-download-checklist.md"),
    [v3Job]
  );
  const v3SafetyReportFile = useMemo(
    () => findV3DeliveryFile(v3Job, "production-gate.json") ?? findV3DeliveryFile(v3Job, "nc-static-analysis.json") ?? findV3DeliveryFile(v3Job, "operator-runbook.md"),
    [v3Job]
  );
  const v3DownloadChecklistSummary = useMemo(() => createV3DownloadChecklistSummary(v3Job), [v3Job]);
  const isOriginalModelSource = Boolean(originalModelFileName);
  const isOriginalModelLocalPreview = Boolean(originalModelFileName && aiMeshUrl?.startsWith("blob:"));
  const isModelReadyForCam = Boolean(aiMeshStlUrl && !isOriginalModelLocalPreview);
  const canDownloadAirRun = Boolean(airRunProgram || (v3AirRunFile?.url && v3AirRunFile.downloadable));
  const canDownloadOperatorPackage = Boolean(toolpath || v3OperatorPackageFile?.url);
  const canDownloadSafetyReport = Boolean(toolpath || v3SafetyReportFile?.url);
  const v3EvidenceLoopSummary = useMemo(
    () => createV3EvidenceLoopSummary(v3Job, v3DownloadChecklistSummary, selectedMachineAcceptance),
    [v3Job, v3DownloadChecklistSummary, selectedMachineAcceptance]
  );
  const v3TrialWorkflow = useMemo(
    () => createV3TrialWorkflowSummary({
      hasModel: Boolean(isModelReadyForCam || v3Job?.result),
      job: v3Job,
      checklist: v3DownloadChecklistSummary,
      acceptance: selectedMachineAcceptance
    }),
    [isModelReadyForCam, v3Job, v3DownloadChecklistSummary, selectedMachineAcceptance]
  );
  const v3FocusedNextAction = useMemo(
    () => createV3FocusedNextAction(v3TrialWorkflow.activeStep.id, isModelReadyForCam, Boolean(v3Job?.result?.summary.deliveryManifest), isV3JobRunning),
    [isModelReadyForCam, isV3JobRunning, v3Job, v3TrialWorkflow.activeStep.id]
  );
  const v3CamoticsPackageAcceptanceStep = useMemo(
    () => v3Readiness?.acceptancePlan?.steps.find((step) => step.id === "camotics-cli-package") ?? null,
    [v3Readiness]
  );
  const selectedToolpathPoints = selectedToolpathProgram?.points ?? toolpath?.points ?? [];
  const viewingSimulation = workbenchView === "simulation" && Boolean(toolpath);
  const workbenchTitle =
    workbenchView === "simulation" && toolpath
      ? "模拟雕刻"
      : workbenchView === "heatmap" && toolpath
        ? "误差热力图"
      : workbenchView === "gcode" && toolpath
        ? "G-code 预览"
        : workbenchView === "report" && toolpath
          ? "报告摘要"
          : generationLabel;
  const workbenchHint =
    workbenchView === "simulation" && toolpath
      ? "按当前刀路反推雕刻包络曲面，用于下载前检查方向、深浅和包覆范围"
      : workbenchView === "heatmap" && toolpath
        ? "按 X/A 网格显示包络贴合率，粉红区域代表未贴合或采样风险"
      : workbenchView === "gcode" && toolpath
        ? "查看合并程序的前后处理、运动指令和安全高度，不在这里编辑机床代码"
        : workbenchView === "report" && toolpath
          ? "汇总安全、质量、材料去除和成本指标，辅助试雕前复核"
          : "拖动旋转查看 360° 视图，滚轮缩放，右键平移";

  useEffect(() => {
    setExportGate({
      safetyReportReviewed: false,
      airRunVerified: false,
      fixtureConfirmed: false
    });
  }, [toolpath]);

  useEffect(() => () => {
    releaseImportedModelObjectUrl();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY, JSON.stringify(customProcessTemplates));
  }, [customProcessTemplates]);

  useEffect(() => {
    window.localStorage.setItem(MACHINE_FEEDBACK_STORAGE_KEY, JSON.stringify(machineFeedback));
  }, [machineFeedback]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_PROFILE_STORAGE_KEY, JSON.stringify(projectProfile));
  }, [projectProfile]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_ARCHIVE_STORAGE_KEY, JSON.stringify(projectArchives));
  }, [projectArchives]);

  useEffect(() => {
    window.localStorage.setItem(DEPLOYMENT_PROFILE_STORAGE_KEY, JSON.stringify(deploymentProfile));
  }, [deploymentProfile]);

  useEffect(() => {
    window.localStorage.setItem(MACHINE_ACCEPTANCE_STORAGE_KEY, JSON.stringify(machineAcceptanceRecords));
  }, [machineAcceptanceRecords]);

  useEffect(() => {
    const machine = getMachineProfile(settings.machineProfileId);
    if (settings.camMode === "rotaryWrap") return;
    if (machine.axes === settings.camMode) return;
    const compatibleMachine = machineProfiles.find((profile) => profile.axes === settings.camMode);
    if (!compatibleMachine) return;
    setSettings((current) => ({
      ...current,
      machineProfileId: compatibleMachine.id,
      safeZ: compatibleMachine.safeZ,
      postProcessor: current.camMode === "3axis" ? "generic3" : compatibleMachine.controller
    }));
  }, [settings.camMode, settings.machineProfileId]);

  useEffect(() => {
    if (!aiMeshStlUrl) {
      setMeshQuality(null);
      setMeshQualityStatus("等待 STL 模型");
      return;
    }

    let cancelled = false;
    setMeshQuality(null);
    setMeshQualityStatus("正在体检 Mesh");

    fetch("/api/mesh/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stlUrl: aiMeshStlUrl })
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Mesh 体检失败");
        }
        return data as MeshQualityReport;
      })
      .then((report) => {
        if (cancelled) return;
        setMeshQuality(report);
        setMeshQualityStatus(report.verdict === "ready" ? "Mesh 体检通过" : report.verdict === "review" ? "Mesh 需要复核" : "Mesh 建议修复");
      })
      .catch((error) => {
        if (cancelled) return;
        setMeshQualityStatus(error instanceof Error ? error.message : "Mesh 体检失败");
      });

    return () => {
      cancelled = true;
    };
  }, [aiMeshStlUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/orchestrator/engines")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "V3 Orchestrator 引擎探测失败");
        return data.engines as V3EngineStatus[];
      })
      .then((engines) => {
        if (cancelled) return;
        setV3Engines(engines);
        const externalCount = engines.filter((engine) => engine.id !== "internal-mesh-cam" && engine.available).length;
        setV3Status(externalCount > 0 ? `已检测到 ${externalCount} 个外部引擎` : "未检测到 FreeCAD/Blender/CAMotics，将使用内置 CAM fallback 做小闭环");
      })
      .catch((error) => {
        if (cancelled) return;
        setV3Status(error instanceof Error ? error.message : "V3 Orchestrator 引擎探测失败");
    });
    refreshV3JobHistory();
    refreshV3Diagnostics();
    refreshV3AdapterValidation();
    refreshV3NativeCamReadiness();
    refreshV3Readiness();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshV3Diagnostics = async () => {
    try {
      const response = await fetch("/api/orchestrator/diagnostics");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "V3 环境自检失败");
      setV3Diagnostics(data as V3Diagnostics);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 环境自检失败");
    }
  };

  const refreshV3JobHistory = async () => {
    try {
      const response = await fetch("/api/orchestrator/jobs");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "V3 历史任务加载失败");
      setV3JobHistory(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 历史任务加载失败");
    }
  };

  const refreshV3AdapterValidation = async () => {
    try {
      const response = await fetch("/api/orchestrator/adapter-validation/latest");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Adapter 验证记录加载失败");
      setV3AdapterValidation(data.latest ?? null);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "Adapter 验证记录加载失败");
    }
  };

  const handleRunV3AdapterValidation = async (native = false) => {
    try {
      setIsV3AdapterValidating(true);
      setV3Status(native ? "正在调用本机外部 CAM Adapter 验证" : "正在生成外部 CAM Adapter 安全验证报告");
      const response = await fetch("/api/orchestrator/adapter-validation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ native })
      });
      const data = await response.json() as V3AdapterValidationSummary & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Adapter 验证失败");
      setV3AdapterValidation(data);
      setV3Status(`Adapter 验证完成：${data.overall.generatedPlans} 个计划，${data.overall.failed} 个失败`);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "Adapter 验证失败");
    } finally {
      setIsV3AdapterValidating(false);
    }
  };

  const refreshV3NativeCamReadiness = async () => {
    try {
      const response = await fetch("/api/orchestrator/native-cam/latest");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Native CAM 验收记录加载失败");
      setV3NativeCamReadiness(data.latest ?? null);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "Native CAM 验收记录加载失败");
    }
  };

  const handleRunV3NativeCamReadiness = async (strict = false) => {
    try {
      setIsV3NativeCamChecking(true);
      setV3Status(strict ? "正在执行 Native CAM 严格验收" : "正在执行 Native CAM 环境验收");
      const response = await fetch("/api/orchestrator/native-cam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strict })
      });
      const data = await response.json() as V3NativeCamReadinessSummary & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Native CAM 环境验收失败");
      setV3NativeCamReadiness(data);
      setV3Status(`Native CAM 验收完成：${data.summary.readyCount}/${data.summary.requiredCount}，${data.summary.level}`);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "Native CAM 环境验收失败");
    } finally {
      setIsV3NativeCamChecking(false);
    }
  };

  const handleImportV3NativeCamRealOutputAcceptance = async () => {
    if (!v3NativeCamAcceptanceFile && !v3NativeCamAcceptanceZipFile) {
      setV3Status("请先选择 native-cam-real-output-acceptance.json，或选择 Linux 回传的验收 ZIP。");
      return;
    }
    setIsV3NativeCamAcceptanceImporting(true);
    try {
      const acceptanceZipDataUrl = v3NativeCamAcceptanceZipFile ? await fileToDataUrl(v3NativeCamAcceptanceZipFile) : null;
      const acceptance = v3NativeCamAcceptanceFile ? JSON.parse(await v3NativeCamAcceptanceFile.text()) : null;
      const response = await fetch("/api/orchestrator/native-cam/real-output-acceptance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(acceptance ? { acceptance } : {}),
          ...(acceptanceZipDataUrl ? { acceptanceZipDataUrl } : {}),
          sourceName: v3NativeCamAcceptanceZipFile?.name ?? v3NativeCamAcceptanceFile?.name ?? "native-cam-real-output-acceptance"
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "真实 CAM 输出验收导入失败");
      setV3Status(`真实 CAM 输出验收已导入：${data.level ?? "unknown"}，候选 ${data.productionCandidateCount ?? 0}，不安全 ${data.unsafeCount ?? 0}`);
      recordTask({
        category: "cam",
        status: data.level === "ready" ? "ok" : data.level === "critical" ? "error" : "warning",
        title: "导入真实 CAM 输出验收",
        detail: `${v3NativeCamAcceptanceZipFile?.name ?? v3NativeCamAcceptanceFile?.name ?? "native-cam-acceptance"} / ${data.summary ?? data.level ?? "unknown"}`
      });
      setV3NativeCamAcceptanceFile(null);
      setV3NativeCamAcceptanceZipFile(null);
      await refreshV3Readiness();
    } catch (error) {
      const message = error instanceof Error ? error.message : "真实 CAM 输出验收导入失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "导入真实 CAM 输出验收失败",
        detail: message
      });
    } finally {
      setIsV3NativeCamAcceptanceImporting(false);
    }
  };

  const refreshV3Readiness = async () => {
    try {
      const response = await fetch("/api/orchestrator/readiness/latest");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "V3 总门禁记录加载失败");
      setV3Readiness(data.latest ?? null);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 总门禁记录加载失败");
    }
  };

  const handleRunV3Readiness = async () => {
    try {
      setIsV3ReadinessChecking(true);
      setV3Status("正在生成 V3 生产就绪总报告");
      const response = await fetch("/api/orchestrator/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json() as V3ReadinessSummary & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "V3 生产就绪总报告生成失败");
      setV3Readiness(data);
      setV3Status(`V3 总门禁：${data.level}，${data.summary}`);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 生产就绪总报告生成失败");
    } finally {
      setIsV3ReadinessChecking(false);
    }
  };

  const handleImportV3RunbookResult = async () => {
    if (!v3RunbookResultFile && !v3RunbookResultZipFile) {
      setV3Status("请先选择 v3-acceptance-runbook-result.json，或选择 Linux/部署服务器回传的结果 ZIP。");
      return;
    }
    setIsV3RunbookResultImporting(true);
    try {
      const resultZipDataUrl = v3RunbookResultZipFile ? await fileToDataUrl(v3RunbookResultZipFile) : null;
      const result = v3RunbookResultFile ? JSON.parse(await v3RunbookResultFile.text()) : null;
      const response = await fetch("/api/orchestrator/readiness/runbook-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(result ? { result } : {}),
          ...(resultZipDataUrl ? { resultZipDataUrl } : {}),
          sourceName: v3RunbookResultZipFile?.name ?? v3RunbookResultFile?.name ?? "v3-acceptance-runbook-result"
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "V3 验收脚本结果导入失败");
      setV3Status(`验收脚本结果已导入：${data.ok ? "通过" : `失败 ${data.failedCount ?? 0} 项`}，身份 ${data.identityValid ? "已绑定" : "待复核"}`);
      recordTask({
        category: "cam",
        status: data.ok ? "ok" : "warning",
        title: "导入 V3 验收脚本结果",
        detail: `${v3RunbookResultZipFile?.name ?? v3RunbookResultFile?.name ?? "runbook-result"} / failed=${data.failedCount ?? 0} / blocking=${data.blockingFailedCount ?? 0}`
      });
      setV3RunbookResultFile(null);
      setV3RunbookResultZipFile(null);
      await refreshV3Readiness();
    } catch (error) {
      const message = error instanceof Error ? error.message : "V3 验收脚本结果导入失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "导入 V3 验收脚本结果失败",
        detail: message
      });
    } finally {
      setIsV3RunbookResultImporting(false);
    }
  };

  const handleLoadV3Job = async (jobId: string) => {
    try {
      setV3Status(`正在恢复 V3 任务 ${jobId.slice(0, 8)}`);
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
      const job = await response.json() as V3OrchestratorJob;
      if (!response.ok) throw new Error(job.error ?? "V3 任务恢复失败");
      setV3Job(job);
      if (job.result?.toolpath) {
        setToolpath(job.result.toolpath);
        setToolpathKind("rough");
        setWorkbenchView("model");
        setIsSimulationMode(false);
      }
      setV3Status(`已恢复任务 ${job.status}：${job.logs[job.logs.length - 1]?.message ?? job.id}`);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 任务恢复失败");
    }
  };

  const handleCancelV3Job = async () => {
    if (!v3Job || (v3Job.status !== "queued" && v3Job.status !== "running")) return;
    try {
      setV3Status(`正在取消 V3 任务 ${v3Job.id.slice(0, 8)}`);
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/cancel`, {
        method: "POST"
      });
      const job = await response.json() as V3OrchestratorJob;
      if (!response.ok) throw new Error(job.error ?? "V3 任务取消失败");
      setV3Job(job);
      await refreshV3JobHistory();
      setV3Status(job.status === "canceled" ? "任务已取消" : "已请求取消，等待当前阶段停止");
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "V3 任务取消失败");
    }
  };

  const updateSetting = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
    setSettings((current) => normalizeSettings({ ...current, [key]: value }));
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const recordTask = (event: Omit<TaskEvent, "id" | "timestamp">) => {
    setTaskEvents((current) => [
      {
        ...event,
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleString("zh-CN", { hour12: false })
      },
      ...current
    ].slice(0, 80));
  };

  const startTaskJob = (job: Pick<TaskJob, "title" | "detail" | "category" | "retryAction">) => {
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    canceledTaskJobIdsRef.current.delete(id);
    setTaskJobs((current) => [
      {
        ...job,
        id,
        status: "running",
        startedAt,
        startedLabel: new Date(startedAt).toLocaleString("zh-CN", { hour12: false }),
        progress: 8,
        logs: [createTaskJobLog(`开始：${job.detail}`)]
      },
      ...current
    ].slice(0, 24));
    return id;
  };

  const finishTaskJob = (id: string, status: TaskJob["status"], detail: string) => {
    const finishedAt = Date.now();
    setTaskJobs((current) =>
      current.map((job) =>
        job.id === id
          ? job.status === "canceled"
            ? job
            : {
              ...job,
              status,
              detail,
              progress: status === "done" ? 100 : status === "error" ? Math.max(job.progress, 100) : job.progress,
              durationMs: Math.max(0, finishedAt - job.startedAt),
              finishedLabel: new Date(finishedAt).toLocaleString("zh-CN", { hour12: false }),
              logs: [...job.logs, createTaskJobLog(`${status === "done" ? "完成" : status === "error" ? "失败" : "结束"}：${detail}`)]
            }
          : job
      )
    );
  };

  const appendTaskJobLog = (id: string, message: string, progress?: number) => {
    setTaskJobs((current) =>
      current.map((job) =>
        job.id === id
          ? {
              ...job,
              progress: progress === undefined ? job.progress : THREEClamp(progress, job.progress, 98),
              logs: [...job.logs, createTaskJobLog(message)].slice(-40),
              detail: message
            }
          : job
      )
    );
  };

  const isTaskJobCanceled = (id: string) => canceledTaskJobIdsRef.current.has(id);

  const cancelTaskJob = (job: TaskJob) => {
    if (job.status !== "running") return;
    canceledTaskJobIdsRef.current.add(job.id);
    const finishedAt = Date.now();
    setTaskJobs((current) =>
      current.map((item) =>
        item.id === job.id
          ? {
              ...item,
              status: "canceled",
              detail: "用户已取消。若远端任务已经提交，后台服务可能仍会完成，但本页面不会自动采用结果。",
              durationMs: Math.max(0, finishedAt - item.startedAt),
              finishedLabel: new Date(finishedAt).toLocaleString("zh-CN", { hour12: false }),
              logs: [...item.logs, createTaskJobLog("用户取消任务。")]
            }
          : item
      )
    );
    recordTask({
      category: job.category,
      status: "warning",
      title: `取消任务：${job.title}`,
      detail: "已在任务中心标记取消；如为远端 AI 任务，请以服务端最终状态为准。"
    });
  };

  const retryTaskJob = async (job: TaskJob) => {
    if (!job.retryAction || job.status === "running") return;
    recordTask({
      category: job.category,
      status: "warning",
      title: `重试任务：${job.title}`,
      detail: "已按当前页面参数重新发起任务。"
    });
    if (job.retryAction === "generate-ai-mesh") await handleGenerateAiMesh();
    if (job.retryAction === "repair-mesh") await handleRepairMesh();
    if (job.retryAction === "remesh") await handleRemesh();
    if (job.retryAction === "generate-toolpath") await generateToolpathForSettings(settings, false);
    if (job.retryAction === "generate-finish-toolpath") await handleGenerateFinishingToolpath();
  };

  const saveSnapshot = (label: string, snapshotSettings: ModelSettings, detail: string) => {
    setTaskSnapshots((current) => [
      {
        id: crypto.randomUUID(),
        label,
        detail,
        settings: { ...snapshotSettings },
        sourceLabel: generationLabel,
        createdAt: new Date().toLocaleString("zh-CN", { hour12: false })
      },
      ...current
    ].slice(0, 24));
  };

  const restoreSnapshot = (snapshot: TaskSnapshot) => {
    setSettings(normalizeSettings(snapshot.settings));
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    recordTask({
      category: "process",
      status: "ok",
      title: `回退参数版本：${snapshot.label}`,
      detail: `${snapshot.detail}；请重新生成刀路验证。`
    });
  };

  const handleSaveCurrentSnapshot = () => {
    saveSnapshot("手动保存参数", settings, `来源：${generationLabel}`);
    recordTask({
      category: "process",
      status: "ok",
      title: "手动保存参数版本",
      detail: "已保存当前刀具、材料、机床、步距、进给和夹持参数。"
    });
  };

  const updateProjectProfile = <K extends keyof ProjectProfile>(key: K, value: ProjectProfile[K]) => {
    setProjectProfile((current) => ({ ...current, [key]: value }));
  };

  const updateDeploymentProfile = <K extends keyof DeploymentProfile>(key: K, value: DeploymentProfile[K]) => {
    setDeploymentProfile((current) => ({ ...current, [key]: value }));
  };

  const handleSaveProjectProfile = () => {
    recordTask({
      category: "process",
      status: "ok",
      title: "保存项目档案",
      detail: `${projectProfile.projectCode} / ${projectProfile.customerName} / ${formatUserRole(projectProfile.role)}`
    });
  };

  const handleSaveDeploymentProfile = () => {
    recordTask({
      category: "process",
      status: deploymentReadiness.level === "critical" ? "warning" : "ok",
      title: "保存部署与安全方案",
      detail: `${formatDeploymentMode(deploymentProfile.mode)} / ${formatApiKeyLocation(deploymentProfile.apiKeyLocation)} / ${formatComputeTarget(deploymentProfile.computeTarget)}`
    });
  };

  const updateMachineAcceptance = (step: MachineAcceptanceStep, checked: boolean) => {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    setMachineAcceptanceRecords((current) => {
      const existing = getMachineAcceptanceRecord(current, selectedMachine);
      const next: MachineAcceptanceRecord = {
        ...existing,
        machineName: selectedMachine.name,
        controller: selectedMachine.controller,
        updatedAt: now,
        [step]: checked,
        [`${step}At`]: checked ? now : null
      };
      return [next, ...current.filter((record) => record.machineId !== selectedMachine.id)].slice(0, 32);
    });
    if (step === "airRun") {
      setExportGate((current) => ({ ...current, airRunVerified: checked }));
    }
    recordTask({
      category: "cam",
      status: checked ? "ok" : "warning",
      title: `${selectedMachine.name}：${formatMachineAcceptanceStep(step)}${checked ? "通过" : "取消"}`,
      detail: checked ? "该验收项已记录到当前机床 Profile。" : "该验收项已从当前机床 Profile 中移除。"
    });
  };

  const updateMachineAcceptanceNotes = (notes: string) => {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    setMachineAcceptanceRecords((current) => {
      const existing = getMachineAcceptanceRecord(current, selectedMachine);
      const next: MachineAcceptanceRecord = {
        ...existing,
        machineName: selectedMachine.name,
        controller: selectedMachine.controller,
        updatedAt: now,
        notes
      };
      return [next, ...current.filter((record) => record.machineId !== selectedMachine.id)].slice(0, 32);
    });
  };

  const syncV3MachineAcceptance = async () => {
    if (!v3Job?.id) {
      setV3Status("机床验收已保存在本地；当前没有 V3 任务可同步。");
      return;
    }
    setIsV3MachineAcceptanceSyncing(true);
    try {
      const simulationEligible = Boolean(v3Job.result?.summary.productionGate?.simulationEvidence?.productionUnlockEligible);
      const outcome: MachineFeedback["outcome"] = selectedMachineAcceptance.airRun && selectedMachineAcceptance.softTrial
        ? "success"
        : selectedMachineAcceptance.airRun
          ? "review"
          : "failed";
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/machine-acceptance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `machine-acceptance-${selectedMachine.id}-${Date.now()}`,
          source: "frontend-machine-acceptance",
          outcome,
          operator: projectProfile.customerName || projectProfile.projectName || "frontend-operator",
          machineSerial: selectedMachine.id,
          fixtureType: settings.camMode === "rotaryWrap" ? `三轴控制器 + ${settings.rotaryOutputAxis ?? "Y"}轴旋转夹具` : selectedMachine.name,
          materialBatch: selectedMaterial.name,
          programName: "toolpath.nc",
          airRunOk: selectedMachineAcceptance.airRun,
          softTrialOk: selectedMachineAcceptance.softTrial,
          formalTrialOk: selectedMachineAcceptance.formalTrial,
          downloadIntegrity: createV3DownloadIntegrityEvidence(v3Job),
          steps: [
            { id: "read-package", passed: true, evidenceNote: "前端 V3 面板已查看加工包和门禁状态。" },
            { id: "verify-download-integrity", passed: true, evidenceNote: "已按 operator-download-checklist.md 和 package-integrity.json 核对关键 NC 文件哈希与文件用途。" },
            { id: "camotics-preview", passed: simulationEligible, evidenceNote: simulationEligible ? "V3 仿真证据已满足生产解锁条件。" : "当前仿真证据仍需 CAMotics/等效材料去除复核。" },
            { id: "rotary-calibration-airrun", passed: selectedMachineAcceptance.airRun, evidenceNote: selectedMachineAcceptance.airRunAt ?? selectedMachineAcceptance.notes },
            { id: "air-run", passed: selectedMachineAcceptance.airRun, evidenceNote: selectedMachineAcceptance.airRunAt ?? selectedMachineAcceptance.notes },
            { id: "soft-material-trial", passed: selectedMachineAcceptance.softTrial, evidenceNote: selectedMachineAcceptance.softTrialAt ?? selectedMachineAcceptance.notes },
            { id: "formal-trial", passed: selectedMachineAcceptance.formalTrial, evidenceNote: selectedMachineAcceptance.formalTrialAt ?? selectedMachineAcceptance.notes }
          ],
          notes: selectedMachineAcceptance.notes,
          attachments: []
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "机床验收同步失败");
      setV3Status(`机床验收已同步到 V3 任务：${data.log?.recordCount ?? 1} 条记录`);
      recordTask({
        category: "cam",
        status: data.record?.allRequiredPassed ? "ok" : data.record?.outcome === "failed" ? "error" : "warning",
        title: "同步 V3 机床验收",
        detail: data.record?.allRequiredPassed ? "必需验收项已通过并进入生产证据链。" : "验收记录已进入证据链，但仍有必需项待复核。"
      });
      await handleLoadV3Job(v3Job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "机床验收同步失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "同步 V3 机床验收失败",
        detail: message
      });
    } finally {
      setIsV3MachineAcceptanceSyncing(false);
    }
  };

  const handleImportV3CamoticsResult = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再回填 CAMotics 仿真结果。");
      return;
    }
    if (!v3CamoticsResultFile && !v3CamoticsResultZipFile) {
      setV3Status("请先选择 camotics-result.json，或选择 Linux 回传的结果 ZIP。");
      return;
    }
    setIsV3CamoticsImporting(true);
    try {
      const resultZipDataUrl = v3CamoticsResultZipFile ? await fileToDataUrl(v3CamoticsResultZipFile) : null;
      const result = v3CamoticsResultFile ? JSON.parse(await v3CamoticsResultFile.text()) : null;
      const screenshotDataUrl = v3CamoticsScreenshotFile ? await fileToDataUrl(v3CamoticsScreenshotFile) : null;
      const materialMeshText = v3CamoticsMaterialMeshFile ? await v3CamoticsMaterialMeshFile.text() : null;
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/camotics-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(result ? { result } : {}),
          ...(resultZipDataUrl ? { resultZipDataUrl } : {}),
          screenshotDataUrl,
          materialMeshText
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "CAMotics 结果回填失败");
      const level = data.simulationEvidence?.level ?? "unknown";
      const eligible = data.simulationEvidence?.productionUnlockEligible ? "可作为生产仿真证据" : "仍需复核，未解锁生产";
      setV3Status(`CAMotics 结果已回填：${level}，${eligible}`);
      recordTask({
        category: "cam",
        status: data.simulationEvidence?.productionUnlockEligible ? "ok" : "warning",
        title: "回填 CAMotics 材料去除结果",
        detail: `${v3CamoticsResultZipFile?.name ?? v3CamoticsResultFile?.name ?? "camotics-result"} / ${level} / ${eligible}`
      });
      setV3CamoticsResultFile(null);
      setV3CamoticsResultZipFile(null);
      setV3CamoticsScreenshotFile(null);
      setV3CamoticsMaterialMeshFile(null);
      await handleLoadV3Job(v3Job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CAMotics 结果回填失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "回填 CAMotics 结果失败",
        detail: message
      });
    } finally {
      setIsV3CamoticsImporting(false);
    }
  };

  const handleImportV3LinuxCamJobValidation = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再回填 Linux CAM 整单校验。");
      return;
    }
    if (!v3LinuxCamJobValidationFile) {
      setV3Status("请先选择 linux-cam-job-local-validation.json。");
      return;
    }
    setIsV3LinuxCamJobValidationImporting(true);
    try {
      const validation = JSON.parse(await v3LinuxCamJobValidationFile.text());
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/linux-cam-job-validation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validation,
          sourceName: v3LinuxCamJobValidationFile.name
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Linux CAM 整单校验导入失败");
      setV3Status(`Linux CAM 整单校验已导入：${data.validation?.level ?? "unknown"}，等待真实证据包回填`);
      setV3UserNotice({
        level: "info",
        title: "Linux CAM 整单校验已回填",
        detail: `${data.validation?.level ?? "unknown"}；该报告只说明 Linux 执行进度，不解锁生产 NC。`
      });
      recordTask({
        category: "cam",
        status: data.validation?.level === "ready-for-v3-upload" ? "ok" : "warning",
        title: "导入 Linux CAM 整单校验",
        detail: `${v3LinuxCamJobValidationFile.name} / ${data.validation?.summary ?? data.validation?.level ?? "unknown"}`
      });
      setV3LinuxCamJobValidationFile(null);
      setV3Job((current) => current && current.id === v3Job.id ? {
        ...current,
        result: current.result ? {
          ...current.result,
          summary: {
            ...(current.result.summary ?? {}),
            linuxCamJobValidation: {
              level: data.validation?.level ?? "unknown",
              summary: data.validation?.summary ?? null,
              expectedUploads: data.validation?.expectedUploads ?? null,
              productionUnlockEligible: false,
              artifact: "linux-cam-job-local-validation.json",
              importAudit: "linux-cam-job-validation-import.json"
            },
            ...(data.deliveryManifest ? { deliveryManifest: data.deliveryManifest } : {}),
            ...(data.packageIntegrity ? {
              packageIntegrity: {
                schema: data.packageIntegrity.schema,
                status: data.packageIntegrity.status,
                summary: data.packageIntegrity.summary,
                fileCount: data.packageIntegrity.fileCount,
                downloadableCount: data.packageIntegrity.downloadableCount,
                missingDownloadableCount: data.packageIntegrity.missingDownloadableCount,
                totalBytes: data.packageIntegrity.totalBytes,
                files: data.packageIntegrity.files
              }
            } : {})
          } as any
        } : current.result
      } : current);
      await refreshV3JobHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Linux CAM 整单校验导入失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "Linux CAM 整单校验导入失败",
        detail: message
      });
    } finally {
      setIsV3LinuxCamJobValidationImporting(false);
    }
  };

  const handlePrepareV3CamoticsCliPackage = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再生成 CAMotics Linux 准备包。");
      return;
    }
    setIsV3CamoticsPackagePreparing(true);
    try {
      setV3Status("正在生成 CAMotics Linux 仿真准备包");
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/camotics-cli-package`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "CAMotics Linux 准备包生成失败");
      const status = data.status ?? data.report?.status ?? "unknown";
      const motionCount = data.report?.preferredGcodeIdentity?.motionProfile?.motionLineCount;
      setV3Status(`CAMotics Linux 准备包已生成：${status}${motionCount ? `，运动行 ${motionCount}` : ""}`);
      recordTask({
        category: "cam",
        status: data.ok ? "ok" : "warning",
        title: "生成 CAMotics Linux 准备包",
        detail: `${status} / 生产NC仍未解锁`
      });
      await handleLoadV3Job(v3Job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CAMotics Linux 准备包生成失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "生成 CAMotics Linux 准备包失败",
        detail: message
      });
    } finally {
      setIsV3CamoticsPackagePreparing(false);
    }
  };

  const handleRunV3CamoticsExecutionPreflight = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再执行 CAMotics 预检。");
      return;
    }
    setIsV3CamoticsPackagePreparing(true);
    try {
      setV3Status("正在执行 CAMotics 当前主机/服务器预检");
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/camotics-execution-preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "CAMotics 执行预检失败");
      const status = data.status ?? data.report?.status ?? "unknown";
      const currentHost = data.report?.canRunOnCurrentHost ? "当前主机可执行" : "需转到Linux CAM服务器";
      setV3Status(`CAMotics 执行预检：${status}，${currentHost}`);
      recordTask({
        category: "cam",
        status: data.report?.canRunOnCurrentHost ? "ok" : "warning",
        title: "CAMotics 执行预检",
        detail: `${status} / ${currentHost}`
      });
      await handleLoadV3Job(v3Job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CAMotics 执行预检失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "CAMotics 执行预检失败",
        detail: message
      });
    } finally {
      setIsV3CamoticsPackagePreparing(false);
    }
  };

  const handleArchiveProject = () => {
    const archive: ProjectArchive = {
      id: crypto.randomUUID(),
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      projectName: projectProfile.projectName,
      customerName: projectProfile.customerName,
      projectCode: projectProfile.projectCode,
      sourceLabel: generationLabel,
      machineName: selectedMachine.name,
      toolName: selectedTool.name,
      materialName: selectedMaterial.name,
      hasToolpath: Boolean(toolpath),
      exportReady: exportGateReady,
      feedbackCount: machineFeedback.length
    };
    setProjectArchives((current) => [archive, ...current].slice(0, 30));
    recordTask({
      category: "process",
      status: archive.exportReady ? "ok" : "warning",
      title: "归档当前项目",
      detail: `${archive.projectName} / ${archive.hasToolpath ? "已有刀路" : "未生成刀路"} / ${archive.exportReady ? "可正式导出" : "未解锁正式导出"}`
    });
  };

  const applySettingsPreset = (nextSettings: ModelSettings) => {
    setSettings(normalizeSettings(nextSettings));
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleApplyMeshDimensions = () => {
    if (!meshQuality) return;
    const dims = meshQuality.dimensions;
    const axis = meshQuality.detectedLongAxis;
    const length = Math.max(1, dims[axis]);
    const diameterAxes = (["x", "y", "z"] as const).filter((item) => item !== axis);
    const diameter = Math.max(1, (dims[diameterAxes[0]] + dims[diameterAxes[1]]) / 2);
    const nextSettings = roundBlankProfile({
      ...settings,
      lengthMm: Number(length.toFixed(1)),
      diameterMm: Number(diameter.toFixed(1)),
      blankLeftDiameterMm: Number((diameter * 0.92).toFixed(1)),
      blankLeftMidDiameterMm: Number((diameter * 0.98).toFixed(1)),
      blankCenterDiameterMm: Number(diameter.toFixed(1)),
      blankRightMidDiameterMm: Number((diameter * 0.98).toFixed(1)),
      blankRightDiameterMm: Number((diameter * 0.92).toFixed(1)),
      meshLengthAxis: axis
    });
    applySettingsPreset(nextSettings);
    saveSnapshot("Mesh 尺寸校准", nextSettings, `长轴 ${axis.toUpperCase()}，长度 ${length.toFixed(1)}mm，直径 ${diameter.toFixed(1)}mm。`);
    recordTask({
      category: "model",
      status: "ok",
      title: "应用 Mesh 姿态/比例校准",
      detail: `已按体检尺寸同步核胚长度 ${length.toFixed(1)}mm、直径 ${diameter.toFixed(1)}mm，并采用 ${axis.toUpperCase()} 长轴。`
    });
  };

  const applyBlankProfileTemplate = (template: "standard" | "tapered" | "offset") => {
    const base = settings.diameterMm;
    const nextSettings =
      template === "standard"
        ? {
            ...settings,
            blankLeftDiameterMm: base * 0.92,
            blankLeftMidDiameterMm: base * 0.98,
            blankCenterDiameterMm: base,
            blankRightMidDiameterMm: base * 0.98,
            blankRightDiameterMm: base * 0.92
          }
        : template === "tapered"
          ? {
              ...settings,
              blankLeftDiameterMm: base * 0.82,
              blankLeftMidDiameterMm: base * 0.95,
              blankCenterDiameterMm: base,
              blankRightMidDiameterMm: base * 0.95,
              blankRightDiameterMm: base * 0.82
            }
          : {
              ...settings,
              blankLeftDiameterMm: base * 0.86,
              blankLeftMidDiameterMm: base * 0.95,
              blankCenterDiameterMm: base * 1.02,
              blankRightMidDiameterMm: base * 0.9,
              blankRightDiameterMm: base * 0.78
            };
    applySettingsPreset(roundBlankProfile(nextSettings));
    recordTask({
      category: "process",
      status: "ok",
      title: "应用毛坯截面模板",
      detail: `${formatBlankTemplate(template)}：${formatBlankProfile(nextSettings)} mm`
    });
  };

  const handleToolProfileChange = (toolId: string) => {
    applySettingsPreset(applyToolProfile(settings, getToolProfile(toolId)));
  };

  const handleMaterialProfileChange = (materialId: string) => {
    applySettingsPreset(applyMaterialProfile(settings, getMaterialProfile(materialId)));
  };

  const handleMachineProfileChange = (machineId: string) => {
    applySettingsPreset(applyMachineProfile(settings, getMachineProfile(machineId)));
  };

  const applyRotaryYTrialPreset = () => {
    const nextSettings = normalizeSettings({
      ...settings,
      toolProfileId: "vflat-4mm-25deg",
      materialProfileId: "olive-core",
      machineProfileId: "desktop-3axis-rotary-y",
      camMode: "rotaryWrap",
      rotaryOutputAxis: "Y",
      rotaryWrapPerRevolutionMm: 100,
      postProcessor: "wrapY",
      safeZ: 22,
      toolDiameter: 4,
      maxCutDepth: 0.16,
      stockAllowance: 0.08,
      stepoverMm: 0.28,
      stepoverDeg: 1.2,
      feedRate: 180,
      spindleRpm: 12000,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      finishingStrategy: "x-scan"
    });
    applySettingsPreset(nextSettings);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    recordTask({
      category: "process",
      status: "ok",
      title: "应用三轴+Y旋转夹具试雕参数",
      detail: "X=长度，Y=夹具旋转等效行程，Z=刀深；4mm 25° 平底尖刀，保守试雕进给。"
    });
  };

  const handleCamModeChange = (camMode: ModelSettings["camMode"]) => {
    const currentMachine = getMachineProfile(settings.machineProfileId);
    if (camMode === "rotaryWrap") {
      applySettingsPreset({
        ...settings,
        camMode,
        reliefAngleDeg: 360,
        rotaryOutputAxis: settings.rotaryOutputAxis === "X" ? "X" : "Y",
        postProcessor: settings.rotaryOutputAxis === "X" ? "wrapX" : "wrapY"
      });
      return;
    }
    const compatibleMachine =
      currentMachine.axes === camMode
        ? currentMachine
        : machineProfiles.find((machine) => machine.axes === camMode) ?? currentMachine;
    applySettingsPreset({
      ...settings,
      camMode,
      machineProfileId: compatibleMachine.id,
      safeZ: compatibleMachine.safeZ,
      postProcessor: camMode === "3axis" ? "generic3" : compatibleMachine.controller
    });
  };

  const handleProcessTemplateChange = (templateId: string) => {
    const template = allProcessTemplates.find((item) => item.id === templateId) ?? processTemplates[0];
    const nextSettings = applyProcessTemplate(settings, template);
    applySettingsPreset(nextSettings);
    saveSnapshot(`模板：${template.name}`, nextSettings, `${template.intent}；${template.notes}`);
    recordTask({
      category: "process",
      status: "ok",
      title: `应用工艺模板：${template.name}`,
      detail: `${template.intent}；${template.notes}`
    });
  };

  const handleSaveCustomProcessTemplate = () => {
    const now = new Date();
    const tool = getToolProfile(settings.toolProfileId);
    const material = getMaterialProfile(settings.materialProfileId);
    const template: ProcessTemplate = {
      id: `custom-${now.getTime()}`,
      name: `自定义模板 ${customProcessTemplates.length + 1}`,
      intent: "用户保存的当前工艺参数",
      toolProfileId: settings.toolProfileId,
      materialProfileId: settings.materialProfileId,
      maxCutDepth: settings.maxCutDepth,
      stockAllowance: settings.stockAllowance,
      stepoverMm: settings.stepoverMm,
      stepoverDeg: settings.stepoverDeg,
      feedRate: settings.feedRate,
      spindleRpm: settings.spindleRpm,
      finishingStrategy: settings.finishingStrategy,
      notes: `${tool.name} / ${material.name} / X步距 ${settings.stepoverMm.toFixed(3)}mm / A步距 ${settings.stepoverDeg.toFixed(1)}°`
    };
    setCustomProcessTemplates((current) => [template, ...current].slice(0, 16));
    saveSnapshot(`保存模板：${template.name}`, settings, template.notes);
    recordTask({
      category: "process",
      status: "ok",
      title: `保存自定义工艺模板：${template.name}`,
      detail: template.notes
    });
  };

  const handleExportCustomProcessTemplates = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      templates: customProcessTemplates
    };
    downloadText("hediao3d-process-templates.json", JSON.stringify(payload, null, 2), "application/json");
    recordTask({
      category: "process",
      status: customProcessTemplates.length > 0 ? "ok" : "warning",
      title: "导出自定义工艺模板",
      detail: `已导出 ${customProcessTemplates.length} 个自定义模板。`
    });
  };

  const handleImportCustomProcessTemplates = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as { templates?: unknown[] };
      const imported = (data.templates ?? []).filter(isProcessTemplate).map((template) => ({
        ...template,
        id: template.id.startsWith("custom-") ? template.id : `custom-import-${Date.now()}-${template.id}`
      }));
      if (imported.length === 0) throw new Error("文件中没有有效模板");
      setCustomProcessTemplates((current) => {
        const existingIds = new Set(current.map((template) => template.id));
        const merged = [...imported.filter((template) => !existingIds.has(template.id)), ...current];
        return merged.slice(0, 16);
      });
      recordTask({
        category: "process",
        status: "ok",
        title: "导入自定义工艺模板",
        detail: `已导入 ${imported.length} 个模板，最多保留 16 个。`
      });
    } catch (error) {
      recordTask({
        category: "process",
        status: "error",
        title: "导入自定义工艺模板失败",
        detail: error instanceof Error ? error.message : "模板 JSON 无法解析"
      });
    }
  };

  const handleImportToolpathFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      if (!isSupportedToolpathFile(file.name)) {
        throw new Error("当前版本支持导入 .nc/.tap/.gcode/.ngc/.cnc/.txt/.csv。STL/OBJ 等几何模型反向导入可后续继续扩展。");
      }

      const text = await file.text();
      const importedToolpath = parseGcodeToToolpath(text, file.name, settings);
      const isThreeAxisImport = importedToolpath.summary.yMin != null && importedToolpath.summary.aMin === 0 && importedToolpath.summary.aMax === 0;
      const rotaryWrapImport = readImportedRotaryWrapSettings(text);
      const currentMachine = getMachineProfile(settings.machineProfileId);
      const importedCamMode: ModelSettings["camMode"] = rotaryWrapImport ? "rotaryWrap" : isThreeAxisImport ? "3axis" : settings.camMode;
      const compatibleMachine =
        importedCamMode === "rotaryWrap"
          ? currentMachine
          : currentMachine.axes === importedCamMode
          ? currentMachine
          : machineProfiles.find((machine) => machine.axes === importedCamMode) ?? currentMachine;
      const nextSettings: ModelSettings = {
        ...settings,
        camMode: importedCamMode,
        machineProfileId: compatibleMachine.id,
        safeZ: importedCamMode === "rotaryWrap" ? settings.safeZ : compatibleMachine.safeZ,
        rotaryOutputAxis: rotaryWrapImport?.axis ?? settings.rotaryOutputAxis,
        rotaryWrapPerRevolutionMm: rotaryWrapImport?.perRevMm ?? settings.rotaryWrapPerRevolutionMm,
        postProcessor: rotaryWrapImport?.axis === "X" ? "wrapX" : rotaryWrapImport?.axis === "Y" ? "wrapY" : isThreeAxisImport ? "generic3" : settings.postProcessor
      };
      setSettings(nextSettings);
      setToolpath(importedToolpath);
      setToolpathKind("rough");
      setIsSimulationMode(true);
      setWorkbenchView("simulation");
      saveSnapshot("导入刀路反向预览", nextSettings, `${file.name}，点数 ${importedToolpath.points.length}，估算 ${importedToolpath.estimatedMinutes.toFixed(1)} min。`);
      recordTask({
        category: "cam",
        status: importedToolpath.summary.warnings.length > 1 ? "warning" : "ok",
        title: "导入 NC/G-code 反向预览",
        detail: `${file.name} 已解析 ${importedToolpath.points.length} 个运动点，${importedToolpath.postProcessorName}。`
      });
    } catch (error) {
      recordTask({
        category: "cam",
        status: "error",
        title: "导入刀路失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
      alert(error instanceof Error ? error.message : "导入刀路失败");
    }
  };

  const handleImportOriginalModelFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["stl", "obj", "glb", "gltf"].includes(extension)) {
      const message = "当前支持导入 .stl/.obj/.glb/.gltf 原始3D模型。";
      recordTask({
        category: "model",
        status: "error",
        title: "导入原始3D模型失败",
        detail: message
      });
      alert(message);
      return;
    }

    releaseImportedModelObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    importedModelObjectUrlRef.current = objectUrl;
    setAiMeshUrl(objectUrl);
    setAiMeshStlUrl(extension === "stl" ? objectUrl : null);
    setOriginalModelFileName(file.name);
    setMeshQuality(null);
    setModelSubStage("ai");
    setWorkbenchView("model");
    setIsSimulationMode(false);
    setGenerationLabel(`原始3D模型：${file.name}`);
    setAiMeshStatus(`正在上传原始3D模型到本地 CAM 缓存：${file.name}`);
    saveSnapshot("导入原始3D模型", settings, `${file.name}，格式 ${extension.toUpperCase()}。`);
    recordTask({
      category: "model",
      status: "ok",
      title: "导入原始3D模型",
      detail: `${file.name} 已载入右侧 3D 视图${toolpath ? "，并叠加当前刀路。" : "。"}`
    });

    try {
      const dataUrl = await fileToDataUrl(file);
      const response = await fetch("/api/mesh/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "模型上传到本地 CAM 缓存失败");
      releaseImportedModelObjectUrl();
      setAiMeshUrl(data.modelUrl);
      setAiMeshStlUrl(data.camModelUrl);
      setAiMeshStatus(`已导入原始3D模型：${file.name}，可直接生成 Mesh 刀路${toolpath ? "，当前 NC/G-code 已叠加显示" : ""}`);
      setV3UserNotice({
        level: "ok",
        title: "原始3D模型已缓存",
        detail: "模型已上传到后端 CAM 缓存，可以生成试雕刀路与安全包。"
      });
      recordTask({
        category: "model",
        status: "ok",
        title: "原始3D模型已缓存",
        detail: `${file.name} 已保存为 ${data.modelUrl}，可用于生成刀路。`
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "模型上传到本地 CAM 缓存失败；当前只能预览，不能生成刀路");
      setV3UserNotice({
        level: "error",
        title: "原始3D模型缓存失败",
        detail: error instanceof Error ? error.message : "当前只能在右侧预览，后端 CAM 暂时不能读取该模型。"
      });
      recordTask({
        category: "model",
        status: "error",
        title: "原始3D模型缓存失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
    }
  };

  const handleClearTaskSnapshots = () => {
    const count = taskSnapshots.length;
    setTaskSnapshots([]);
    recordTask({
      category: "tasks",
      status: count > 0 ? "warning" : "ok",
      title: "清空参数版本",
      detail: count > 0 ? `已清空 ${count} 条参数快照。` : "当前没有可清空的参数快照。"
    });
  };

  const toggleFeedbackIssue = (issue: string) => {
    setFeedbackDraft((current) => ({
      ...current,
      issues: current.issues.includes(issue)
        ? current.issues.filter((item) => item !== issue)
        : [...current.issues, issue]
    }));
  };

  const handleFeedbackPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const photoUrl = await fileToDataUrl(file);
    setFeedbackDraft((current) => ({
      ...current,
      photoName: file.name,
      photoUrl
    }));
    event.target.value = "";
  };

  const handleSaveMachineFeedback = () => {
    const actualMinutes = Number(feedbackDraft.actualMinutes);
    const normalizedActual = Number.isFinite(actualMinutes) && actualMinutes > 0 ? actualMinutes : null;
    const feedback: MachineFeedback = {
      id: crypto.randomUUID(),
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      outcome: feedbackDraft.outcome,
      sourceLabel: generationLabel,
      machineName: selectedMachine.name,
      toolName: selectedTool.name,
      materialName: selectedMaterial.name,
      estimatedMinutes: toolpath?.estimatedMinutes ?? null,
      actualMinutes: normalizedActual,
      costEstimateRange: costEstimate ? formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh) : null,
      issues: feedbackDraft.issues,
      notes: feedbackDraft.notes.trim(),
      photoName: feedbackDraft.photoName,
      photoUrl: feedbackDraft.photoUrl,
      settings: { ...settings }
    };
    setMachineFeedback((current) => [feedback, ...current].slice(0, 40));
    if (feedback.outcome === "success") {
      saveSnapshot("实机成功参数", settings, `真实耗时 ${feedback.actualMinutes ?? "-"} min；${feedback.notes || "无备注"}`);
    }
    setFeedbackDraft(defaultFeedbackDraft);
    recordTask({
      category: "feedback",
      status: feedback.outcome === "success" ? "ok" : feedback.outcome === "review" ? "warning" : "error",
      title: `记录实机反馈：${formatFeedbackOutcome(feedback.outcome)}`,
      detail: `${feedback.machineName} / ${feedback.toolName} / ${feedback.issues.length > 0 ? feedback.issues.join("、") : "无缺陷标签"}`
    });
    void syncV3TrialFeedback(feedback);
  };

  const syncV3TrialFeedback = async (feedback: MachineFeedback) => {
    if (!v3Job?.id) {
      setV3Status("实机反馈已保存在本地；当前没有 V3 任务可同步。");
      return;
    }
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/trial-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: feedback.id,
          source: "frontend-machine-feedback",
          phase: "soft-trial",
          outcome: feedback.outcome,
          machineName: feedback.machineName,
          toolName: feedback.toolName,
          materialName: feedback.materialName,
          estimatedMinutes: feedback.estimatedMinutes,
          actualMinutes: feedback.actualMinutes,
          costEstimateRange: feedback.costEstimateRange,
          issues: feedback.issues,
          notes: feedback.notes,
          photoName: feedback.photoName,
          photoAttached: Boolean(feedback.photoUrl),
          downloadIntegrity: createV3DownloadIntegrityEvidence(v3Job),
          settings: feedback.settings
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "试雕反馈同步失败");
      setV3Status(`试雕反馈已同步到 V3 任务：${data.log?.recordCount ?? 1} 条记录`);
      await handleLoadV3Job(v3Job.id);
    } catch (error) {
      setV3Status(error instanceof Error ? error.message : "试雕反馈同步失败");
    }
  };

  const restoreFeedbackSettings = (feedback: MachineFeedback) => {
    setSettings(feedback.settings);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    setActiveStage("process");
    recordTask({
      category: "feedback",
      status: "ok",
      title: "复用实机反馈参数",
      detail: `${feedback.createdAt} / ${formatFeedbackOutcome(feedback.outcome)} / ${feedback.toolName}`
    });
  };

  const deleteMachineFeedback = (feedback: MachineFeedback) => {
    setMachineFeedback((current) => current.filter((item) => item.id !== feedback.id));
    recordTask({
      category: "feedback",
      status: "warning",
      title: "删除实机反馈记录",
      detail: `${feedback.createdAt} / ${formatFeedbackOutcome(feedback.outcome)}`
    });
  };

  const handleDeleteCustomProcessTemplate = (templateId: string) => {
    const template = customProcessTemplates.find((item) => item.id === templateId);
    setCustomProcessTemplates((current) => current.filter((item) => item.id !== templateId));
    if (template) {
      recordTask({
        category: "process",
        status: "warning",
        title: `删除自定义工艺模板：${template.name}`,
        detail: "模板已从本机浏览器保存区移除，不影响已有参数快照。"
      });
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    setIsReading(true);
    try {
      const loaded = await Promise.all(
        files.map(async (file) => {
          const result = await fileToDepthMap(file);
          return {
            id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
            name: file.name,
            quality: analyzeDepthMapQuality(result.depthMap),
            ...result
          };
        })
      );
      setImages((current) => [...current, ...loaded]);
      setActiveId(loaded[0].id);
      setGeneratedDepth(null);
      releaseImportedModelObjectUrl();
      setAiMeshUrl(null);
      setAiMeshStlUrl(null);
      setOriginalModelFileName(null);
      setMeshQuality(null);
      setGenerationLabel("图片已载入，待生成3D");
      setToolpath(null);
      setIsSimulationMode(false);
      setWorkbenchView("model");
      recordTask({
        category: "source",
        status: "ok",
        title: "上传图片素材",
        detail: `已读取 ${loaded.length} 张图片，首张质量评分 ${loaded[0].quality?.score.toFixed(1) ?? "-"}。`
      });
    } finally {
      setIsReading(false);
      event.target.value = "";
    }
  };

  const handleGenerateToolpath = async () => {
    await generateToolpathForSettings(settings, false);
  };

  const handleRunV3OrchestratorLoop = async () => {
    if (!isModelReadyForCam) {
      const message = isOriginalModelLocalPreview
        ? "原始3D模型仍在本地预览状态，等待上传到后端 CAM 缓存后才能生成试雕刀路。"
        : "请先导入或生成一个 GLB/STL 模型，再生成试雕刀路与安全包。";
      setV3Status(message);
      setV3UserNotice({
        level: "warning",
        title: "模型还不能生成刀路",
        detail: message
      });
      return;
    }

    setIsV3JobRunning(true);
    setV3UserNotice({
      level: "info",
      title: "正在生成试雕刀路与安全包",
      detail: "后端会生成候选 NC、空跑、标定、报告和下载核验清单。"
    });
    setV3Status("正在提交 V3 Orchestrator 试雕刀路任务");
    const jobId = startTaskJob({
      category: "cam",
      title: "生成试雕刀路与安全包",
      detail: "正在探测外部 CAM 引擎，并用当前模型验证 Orchestrator -> CAM -> 后处理 -> 预览闭环。",
      retryAction: "generate-toolpath"
    });

    try {
      appendTaskJobLog(jobId, "提交 Orchestrator job。", 20);
      const response = await fetch("/api/orchestrator/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelUrl: aiMeshStlUrl, settings, engine: "auto" })
      });
      const data = await response.json() as V3OrchestratorJob;
      if (!response.ok) throw new Error(data.error ?? "V3 Orchestrator 小闭环失败");

      setV3Job(data);
      appendTaskJobLog(jobId, `任务已创建：${data.id}`, 36);
      setV3Status(`任务 ${data.status}，正在等待 Orchestrator 后台处理`);
      const finalJob = await pollV3OrchestratorJob(data.id, (job) => {
        setV3Job(job);
        setV3Status(`任务 ${job.status}：${job.logs[job.logs.length - 1]?.message ?? "处理中"}`);
      });

      if (finalJob.status === "canceled") {
        await refreshV3JobHistory();
        finishTaskJob(jobId, "canceled", "V3 Orchestrator 任务已取消。");
        setV3Status("V3 Orchestrator 任务已取消");
      } else if (finalJob.result?.toolpath) {
        setToolpath(finalJob.result.toolpath);
        setToolpathKind("rough");
        setWorkbenchView("simulation");
        setIsSimulationMode(true);
        await refreshV3JobHistory();
        appendTaskJobLog(jobId, `返回刀路：${finalJob.result.summary.points} 点。`, 86);
        finishTaskJob(jobId, "done", `完成：${finalJob.result.engine}，${finalJob.result.summary.points} 点。`);
        setV3Status(`试雕刀路与安全包已生成：${finalJob.result.engine}${finalJob.result.fallbackFrom !== finalJob.result.engine ? `（从 ${finalJob.result.fallbackFrom} fallback）` : ""}`);
        setV3UserNotice({
          level: "ok",
          title: "试雕刀路已生成",
          detail: `已生成 ${finalJob.result.summary.points} 个刀路点；右侧已切到“模拟雕刻”，可先检查方向、包覆范围和深浅。`
        });
      } else {
        finishTaskJob(jobId, "error", finalJob.error ?? "Orchestrator 未返回刀路");
        setV3Status(finalJob.error ?? "Orchestrator 未返回刀路");
        setV3UserNotice({
          level: "error",
          title: "未生成刀路",
          detail: finalJob.error ?? "Orchestrator 未返回刀路"
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "V3 Orchestrator 小闭环失败";
      setV3Status(message);
      setV3UserNotice({
        level: "error",
        title: "生成试雕刀路失败",
        detail: message
      });
      finishTaskJob(jobId, "error", message);
      recordTask({
        category: "cam",
        status: "error",
        title: "V3 Orchestrator 小闭环失败",
        detail: message
      });
    } finally {
      setIsV3JobRunning(false);
    }
  };

  const downloadUrlAsset = async (url: string, fallbackName: string, context: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = "";
      try {
        const data = JSON.parse(text) as { error?: string; summary?: string };
        detail = data.summary ?? data.error ?? "";
      } catch {
        detail = text.trim().slice(0, 180);
      }
      throw new Error(`${context}失败：${detail || response.status}`);
    }
    const blob = await response.blob();
    const headerName = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
    const filename = headerName ? decodeURIComponent(headerName) : extractDownloadFilename(url, fallbackName);
    downloadBlob(filename, blob);
    return filename;
  };

  const handleDownloadOperatorPackage = async () => {
    const v3Runbook = findV3DeliveryFile(v3Job, "operator-runbook.md");
    const v3Checklist = findV3DeliveryFile(v3Job, "operator-download-checklist.md");
    const v3File = v3Runbook?.url ? v3Runbook : v3Checklist;
    if (v3File?.url) {
      try {
        const filename = await downloadUrlAsset(v3File.url, v3File.filename, "加工包说明下载");
        setV3Status(`加工包说明已开始下载：${filename}`);
        setV3UserNotice({
          level: "ok",
          title: "加工包说明已开始下载",
          detail: filename
        });
        recordTask({
          category: "cam",
          status: "ok",
          title: "下载加工包说明",
          detail: `已下载 V3 后端生成的 ${filename}。`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "加工包说明下载失败";
        setV3Status(message);
        setV3UserNotice({ level: "error", title: "加工包说明下载失败", detail: message });
        recordTask({ category: "cam", status: "error", title: "加工包说明下载失败", detail: message });
      }
      return;
    }
    if (!toolpath) {
      setV3Status("请先生成刀路或 V3 安全包，再下载加工包说明。");
      return;
    }
    const content = createOperatorPackageMarkdown({
      settings,
      toolpath,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      tool: selectedTool,
      material: selectedMaterial,
      machine: selectedMachine,
      machineAcceptance: selectedMachineAcceptance,
      safetyIssues,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate
    });
    downloadText("operator-note.md", content, "text/markdown");
  };

  const handleDownloadModelAsset = async (url: string, fallbackName: string) => {
    try {
      const filename = await downloadUrlAsset(url, fallbackName, "模型文件下载");
      setV3UserNotice({
        level: "ok",
        title: "模型文件已开始下载",
        detail: filename
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型文件下载失败";
      setAiMeshStatus(message);
      setV3Status(message);
      setV3UserNotice({
        level: "error",
        title: "模型文件下载失败",
        detail: message
      });
      recordTask({
        category: "model",
        status: "error",
        title: "模型文件下载失败",
        detail: message
      });
    }
  };

  const handleDownloadV3Package = async () => {
    const manifest = v3Job?.result?.summary.deliveryManifest;
    if (!v3Job || !manifest) {
      setV3Status("请先运行 V3 小闭环，生成交付清单后再下载加工包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在请求 V3 正式生产包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/production-package`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 423) {
          const detail = formatLockedProductionPackageGuidance(data);
          setV3Status(data.error ?? "V3 正式生产包未解锁");
          setV3UserNotice({
            level: "warning",
            title: "正式生产包未解锁",
            detail
          });
          recordTask({
            category: "cam",
            status: "warning",
            title: "V3 正式生产包未解锁",
            detail,
            actionLinks: createLockedProductionPackageTaskLinks(data)
          });
          return;
        }
        throw new Error(data.summary ?? data.error ?? `V3 正式生产包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `hediao3d-v3-${v3Job.id.slice(0, 8)}-production-${stamp}.zip`;
      downloadBlob(filename, blob);
      setV3Status("V3 正式生产包已由 Orchestrator 打包");
      setV3UserNotice({
        level: "ok",
        title: "正式生产包已开始下载",
        detail: filename
      });
      recordTask({
        category: "cam",
        status: "ok",
        title: "下载 V3 正式生产包",
        detail: "后端生产门禁已放行，正式生产包由 Orchestrator 统一生成。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "V3 正式生产包下载失败";
      setV3Status(message);
      setV3UserNotice({
        level: "warning",
        title: "正式生产包未解锁",
        detail: message
      });
      recordTask({
        category: "cam",
        status: "warning",
        title: "V3 正式生产包未解锁",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadV3TrialPackage = async () => {
    const manifest = v3Job?.result?.summary.deliveryManifest;
    if (!v3Job || !manifest) {
      setV3Status("请先运行 V3 小闭环，生成交付清单后再下载安全试雕包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在打包 V3 安全试雕包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/trial-package`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `安全试雕包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `hediao3d-v3-${v3Job.id.slice(0, 8)}-safe-trial-${stamp}.zip`;
      downloadBlob(filename, blob);
      setV3Status("V3 安全试雕包已由 Orchestrator 打包");
      setV3UserNotice({
        level: manifest.allowTrialNc ? "ok" : "warning",
        title: "安全试雕包已开始下载",
        detail: manifest.allowTrialNc ? filename : `${filename}；当前未放行试雕 NC，请只按包内说明做空跑/标定。`
      });
      recordTask({
        category: "cam",
        status: manifest.allowTrialNc ? "ok" : "warning",
        title: "下载 V3 安全试雕包",
        detail: manifest.allowTrialNc ? "已包含试雕候选 NC、空跑和核验说明。" : "当前未放行试雕 NC，仅包含空跑、标定和报告。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "V3 安全试雕包下载失败";
      setV3Status(message);
      setV3UserNotice({
        level: "error",
        title: "安全试雕包下载失败",
        detail: message
      });
      recordTask({
        category: "cam",
        status: "error",
        title: "V3 安全试雕包下载失败",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadV3CamoticsLinuxPackage = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再下载 CAMotics Linux 仿真包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在打包 CAMotics Linux 仿真包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/camotics-linux-package`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `CAMotics Linux 仿真包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `hediao3d-v3-${v3Job.id.slice(0, 8)}-camotics-linux-${stamp}.zip`;
      downloadBlob(filename, blob);
      setV3Status("CAMotics Linux 仿真包已由 Orchestrator 打包");
      setV3UserNotice({
        level: "ok",
        title: "Linux 仿真包已开始下载",
        detail: filename
      });
      recordTask({
        category: "cam",
        status: "ok",
        title: "下载 CAMotics Linux 仿真包",
        detail: "包含预览 NC、运行脚本、校验器、操作清单和结果回填模板；不会解锁生产 NC。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "CAMotics Linux 仿真包下载失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "warning",
        title: "CAMotics Linux 仿真包下载失败",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadV3OpenCamLibCandidateInputs = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再下载 OpenCAMLib 输入包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在打包 OpenCAMLib Linux 输入包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/opencamlib-candidate-inputs.zip`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `OpenCAMLib 输入包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `hediao3d-v3-${v3Job.id.slice(0, 8)}-opencamlib-inputs-${stamp}.zip`;
      downloadBlob(filename, blob);
      setV3Status("OpenCAMLib Linux 输入包已由 Orchestrator 打包");
      setV3UserNotice({
        level: "ok",
        title: "OpenCAMLib 输入包已开始下载",
        detail: `${filename}；复制到 Linux Native CAM 服务包目录后运行 real candidate 脚本。`
      });
      recordTask({
        category: "cam",
        status: "ok",
        title: "下载 OpenCAMLib Linux 输入包",
        detail: "包含 job.json、opencamlib-kernel-plan.json、STL 模型和清单；只用于真实 CAM 候选验证，不解锁生产 NC。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenCAMLib 输入包下载失败";
      setV3Status(message);
      setV3UserNotice({
        level: "warning",
        title: "OpenCAMLib 输入包下载失败",
        detail: message
      });
      recordTask({
        category: "cam",
        status: "warning",
        title: "OpenCAMLib 输入包下载失败",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadV3LinuxCamJobPackage = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再下载 Linux CAM 整单包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在打包 Linux CAM 整单执行包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/linux-cam-job-package`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `Linux CAM 整单包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `hediao3d-v3-${v3Job.id.slice(0, 8)}-linux-cam-job-${stamp}.zip`;
      downloadBlob(filename, blob);
      setV3Status("Linux CAM 整单执行包已由 Orchestrator 打包");
      setV3UserNotice({
        level: "ok",
        title: "Linux CAM 整单包已开始下载",
        detail: `${filename}；包含 OpenCAMLib 输入、CAMotics 仿真准备、闭环说明和回填清单。`
      });
      recordTask({
        category: "cam",
        status: "ok",
        title: "下载 Linux CAM 整单执行包",
        detail: "将当前 job 的 OpenCAMLib 真实候选输入、CAMotics 材料去除仿真文件和证据回填说明放入同一个 ZIP；不解锁生产 NC。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Linux CAM 整单包下载失败";
      setV3Status(message);
      setV3UserNotice({
        level: "warning",
        title: "Linux CAM 整单包下载失败",
        detail: message
      });
      recordTask({
        category: "cam",
        status: "warning",
        title: "Linux CAM 整单包下载失败",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadV3EvidenceReviewPackage = async () => {
    if (!v3Job?.id) {
      setV3Status("请先运行或恢复一个 V3 任务，再下载证据审查包。");
      return;
    }

    setIsV3PackageDownloading(true);
    setV3Status("正在打包 V3 证据审查包");
    try {
      const response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(v3Job.id)}/evidence-review-package`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `证据审查包下载失败：${response.status}`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(`hediao3d-v3-${v3Job.id.slice(0, 8)}-evidence-review-${stamp}.zip`, blob);
      setV3Status("V3 证据审查包已由 Orchestrator 打包");
      recordTask({
        category: "cam",
        status: "ok",
        title: "下载 V3 证据审查包",
        detail: "用于复核当前 job 的门禁、哈希、仿真、后处理和现场证据缺口；不是上机加工包。"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "V3 证据审查包下载失败";
      setV3Status(message);
      recordTask({
        category: "cam",
        status: "error",
        title: "V3 证据审查包下载失败",
        detail: message
      });
    } finally {
      setIsV3PackageDownloading(false);
    }
  };

  const handleDownloadAirRun = async () => {
    const v3AirRun = findV3DeliveryFile(v3Job, "air-run.nc");
    if (v3AirRun?.url && v3AirRun.downloadable) {
      try {
        const filename = await downloadUrlAsset(v3AirRun.url, v3AirRun.filename, "离料空跑 NC 下载");
        setExportGate((current) => ({ ...current, airRunVerified: true }));
        setV3Status(`离料空跑 NC 已开始下载：${filename}`);
        setV3UserNotice({
          level: "ok",
          title: "离料空跑 NC 已开始下载",
          detail: "只允许主轴关闭、离料状态下验证行程和方向。"
        });
        recordTask({
          category: "cam",
          status: "ok",
          title: "下载离料空跑程序",
          detail: `已下载 V3 后端生成的 ${filename}。`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "离料空跑 NC 下载失败";
        setV3Status(message);
        setV3UserNotice({ level: "error", title: "离料空跑 NC 下载失败", detail: message });
        recordTask({ category: "cam", status: "error", title: "离料空跑 NC 下载失败", detail: message });
      }
      return;
    }
    if (!airRunProgram) {
      setV3Status("请先生成刀路或 V3 安全包，再下载离料空跑 NC。");
      return;
    }
    downloadText(airRunProgram.filename, airRunProgram.gcode);
    setExportGate((current) => ({ ...current, airRunVerified: true }));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: "下载离料空跑程序",
      detail: exportBlocked ? "当前正式程序存在阻断项，空跑前仍需确认 X/A 行程和夹具距离。" : "空跑程序主轴关闭，Z 保持安全高度，用于验证机器动作。"
    });
  };

  const createReportInput = () => {
    if (!toolpath) return null;
    return {
      settings,
      toolpath,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      tool: selectedTool,
      material: selectedMaterial,
      machine: selectedMachine,
      safetyIssues,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate,
      machineAcceptance: selectedMachineAcceptance,
      exportGate,
      safetyGate: {
        level: safetyGateStatus.level,
        title: safetyGateStatus.title,
        detail: safetyGateStatus.detail,
        productionUnlocked: safetyGateStatus.canDownloadProduction
      }
    };
  };

  const handleDownloadZipPackage = () => {
    const reportInput = createReportInput();
    if (!reportInput) return;

    const operatorNote = createOperatorPackageMarkdown(reportInput);
    const previewPng = captureWorkbenchPreviewPng();
    const previewIndex = createPreviewIndexMarkdown({
      sourceLabel: generationLabel,
      workbenchView,
      hasPreviewPng: Boolean(previewPng),
      envelopeQuality,
      envelopeHeatmapDiagnosis,
      meshQuality,
      materialRemoval
    });
    const manufacturingSummary = createManufacturingSummaryMarkdown({
      reportInput,
      costEstimate,
      envelopeQuality,
      envelopeHeatmapDiagnosis,
      safetyGateStatus
    });
    const parameters = createPackageParameters({
      projectProfile,
      deploymentProfile,
      machineAcceptance: selectedMachineAcceptance,
      settings,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      selectedTool,
      selectedMaterial,
      selectedMachine,
      toolpath,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate,
      envelopeQuality,
      envelopeHeatmapDiagnosis,
      exportGate,
      safetyGateStatus
    });
    const checklist = createPackageChecklist(reportInput, Boolean(exportGateReady), Boolean(aiMeshUrl), safetyGateStatus);
    const files: ZipFile[] = [
      { name: "manifest.json", content: JSON.stringify(createPackageManifest(reportInput), null, 2), mime: "application/json" },
      { name: "parameters.json", content: JSON.stringify(parameters, null, 2), mime: "application/json" },
      { name: "operator-note.md", content: operatorNote, mime: "text/markdown" },
      { name: "preview/preview-index.md", content: previewIndex, mime: "text/markdown" },
      { name: "reports/manufacturing-summary.md", content: manufacturingSummary, mime: "text/markdown" },
      { name: "reports/package-checklist.md", content: checklist, mime: "text/markdown" },
      { name: "reports/safety-report.json", content: JSON.stringify(createSafetyReport(reportInput), null, 2), mime: "application/json" },
      { name: "reports/quality-report.json", content: JSON.stringify(createQualityReport(reportInput), null, 2), mime: "application/json" },
      { name: "reports/cost-estimate.json", content: JSON.stringify(costEstimate, null, 2), mime: "application/json" },
      ...(airRunProgram ? [{ name: `nc/${airRunProgram.filename}`, content: airRunProgram.gcode }] : []),
      { name: "nc/nuclear-carving-combined.nc", content: toolpath.gcode },
      { name: "nc/nuclear-carving-toolpath.tap", content: toolpath.tap },
      { name: "nc/nuclear-carving-toolpath.txt", content: toolpath.txt },
      { name: "nc/nuclear-carving-toolpath.csv", content: toolpath.csv, mime: "text/csv" }
    ];

    if (previewPng) {
      files.push({ name: "preview/simulation-result.png", content: previewPng, mime: "image/png" });
    }
    if (!aiMeshUrl) {
      files.push({ name: "models/source.stl", content: geometryToStlString(geometry), mime: "model/stl" });
    } else {
      files.push({
        name: "models/model-download-links.md",
        content: [
          "# AI Mesh 模型下载链接",
          "",
          aiMeshUrl ? `- GLB：${aiMeshUrl}` : "- GLB：未生成",
          aiMeshStlUrl ? `- STL：${aiMeshStlUrl}` : "- STL：未生成",
          "",
          "说明：AI Mesh 文件可能由本地代理缓存，请在归档前从页面下载 GLB/STL 原文件。"
        ].join("\n"),
        mime: "text/markdown"
      });
    }

    if (toolpath.programs?.rough) {
      files.push({ name: `nc/${toolpath.programs.rough.filename}`, content: toolpath.programs.rough.gcode });
    }
    if (toolpath.programs?.finish) {
      files.push({ name: `nc/${toolpath.programs.finish.filename}`, content: toolpath.programs.finish.gcode });
    }
    if (toolpath.programs?.rest) {
      files.push({ name: `nc/${toolpath.programs.rest.filename}`, content: toolpath.programs.rest.gcode });
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const projectSlug = createFileSlug(projectProfile.projectCode || projectProfile.projectName);
    const machineSlug = createFileSlug(selectedMachine.id);
    const toolSlug = createFileSlug(selectedTool.id);
    downloadBlob(`hediao3d-${projectSlug}-${stamp}-${machineSlug}-${toolSlug}-v2.zip`, createZipBlob(files));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: "导出 ZIP 加工包",
      detail: `已打包 ${files.length} 个文件，包含 NC、报告、参数、预览截图和上机说明。`
    });
  };

  const handleDownloadSafetyReport = async (format: "json" | "md") => {
    const v3File = format === "json"
      ? findV3DeliveryFile(v3Job, "production-gate.json") ?? findV3DeliveryFile(v3Job, "nc-static-analysis.json")
      : findV3DeliveryFile(v3Job, "operator-runbook.md") ?? findV3DeliveryFile(v3Job, "operator-download-checklist.md");
    if (v3File?.url) {
      try {
        const filename = await downloadUrlAsset(v3File.url, v3File.filename, `安全报告 ${format.toUpperCase()} 下载`);
        setExportGate((current) => ({ ...current, safetyReportReviewed: true }));
        setV3Status(`安全报告已开始下载：${filename}`);
        setV3UserNotice({
          level: "ok",
          title: "安全报告已开始下载",
          detail: filename
        });
        recordTask({
          category: "cam",
          status: v3File.downloadable ? "ok" : "warning",
          title: `下载安全报告：${format.toUpperCase()}`,
          detail: `已下载 V3 后端生成的 ${filename}。`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "安全报告下载失败";
        setV3Status(message);
        setV3UserNotice({ level: "error", title: "安全报告下载失败", detail: message });
        recordTask({ category: "cam", status: "error", title: "安全报告下载失败", detail: message });
      }
      return;
    }
    const reportInput = createReportInput();
    if (!reportInput) {
      setV3Status("请先生成刀路或 V3 安全包，再下载安全报告。");
      return;
    }
    if (format === "json") {
      downloadText("safety-report.json", JSON.stringify(createSafetyReport(reportInput), null, 2), "application/json");
    } else {
      downloadText("safety-report.md", createSafetyReportMarkdown(reportInput), "text/markdown");
    }
    setExportGate((current) => ({ ...current, safetyReportReviewed: true }));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: `下载安全报告：${format.toUpperCase()}`,
      detail: exportBlocked ? "安全报告包含阻断项，正式上机前需修复。" : "安全报告可用于离料空跑前复核。"
    });
  };

  const handleGenerateFinishingToolpath = async () => {
    const finishingSettings = createFinishingSettings(settings);
    setSettings(finishingSettings);
    await generateToolpathForSettings(finishingSettings, true);
  };

  const generateToolpathForSettings = async (baseSettings: ModelSettings, finishing: boolean) => {
    if (aiMeshUrl) {
      if (isOriginalModelLocalPreview) {
        setAiMeshStatus("原始3D模型仍在本地预览状态，后端 CAM 还不能读取；请等待上传到本地 CAM 缓存完成后再生成刀路。");
        recordTask({
          category: "cam",
          status: "warning",
          title: "原始模型尚未缓存",
          detail: "浏览器 blob 模型无法被后端 CAM 采样服务直接读取；上传完成后会自动切换为 /imported-models 地址。"
        });
        return;
      }
      if (!aiMeshStlUrl) {
        setAiMeshStatus("当前 Meshy 模型没有本地 STL，无法生成 Mesh 贴面刀路");
        return;
      }

      const meshCamSettings = baseSettings.camMode === "3axis" ? { ...baseSettings, reliefAngleDeg: 0 } : { ...baseSettings, reliefAngleDeg: 360 };
      if (baseSettings.camMode !== "3axis" && baseSettings.reliefAngleDeg !== 360) {
        setSettings(meshCamSettings);
      }
      setIsToolpathGenerating(true);
      setAiMeshStatus(
        baseSettings.camMode === "3axis"
          ? "正在按 Meshy STL 顶面投影生成三轴 X/Y/Z 刀路"
          : baseSettings.camMode === "rotaryWrap"
            ? `正在生成旋转包裹刀路：${baseSettings.rotaryOutputAxis}轴驱动夹具`
          : finishing
            ? "正在生成 360° Mesh 精加工刀路"
            : "正在按 360° 包覆对 Meshy STL 做表面采样并生成四轴刀路"
      );
      const jobId = startTaskJob({
        category: "cam",
        title: baseSettings.camMode === "3axis" ? "Mesh 三轴刀路" : baseSettings.camMode === "rotaryWrap" ? "Mesh 旋转包裹刀路" : finishing ? "Mesh 精加工刀路" : "Mesh 四轴刀路",
        detail: baseSettings.camMode === "3axis" ? "正在顶面投影 STL 并生成三轴刀路。" : baseSettings.camMode === "rotaryWrap" ? "正在按 360° 采样 STL，并把旋转角映射到夹具接入轴。" : "正在采样 STL 表面并生成四轴刀路。",
        retryAction: finishing ? "generate-finish-toolpath" : "generate-toolpath"
      });
      try {
        appendTaskJobLog(jobId, "提交 Mesh CAM 采样请求。", 24);
        const response = await fetch("/api/cam/mesh-toolpath", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stlUrl: aiMeshStlUrl, settings: meshCamSettings })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Mesh CAM 刀路生成失败");
        }
        if (isTaskJobCanceled(jobId)) return;
        appendTaskJobLog(jobId, "服务端已返回刀路，正在写入预览和报告。", 86);
        setToolpath(data);
        setToolpathKind(finishing ? "finish" : "rough");
        setIsSimulationMode(false);
        setWorkbenchView("model");
        saveSnapshot(baseSettings.camMode === "3axis" ? "Mesh 三轴刀路" : baseSettings.camMode === "rotaryWrap" ? "Mesh 旋转包裹刀路" : finishing ? "Mesh 精加工刀路" : "Mesh 四轴刀路", meshCamSettings, `点数 ${data.points.length}，估算 ${data.estimatedMinutes.toFixed(1)} min。`);
        setAiMeshStatus(baseSettings.camMode === "3axis" ? "Mesh 三轴 X/Y/Z 刀路已生成，右侧停留在原始3D模型并叠加刀路线" : baseSettings.camMode === "rotaryWrap" ? `Mesh 旋转包裹刀路已生成，右侧停留在原始3D模型并叠加刀路线，${baseSettings.rotaryOutputAxis}轴驱动夹具` : finishing ? "Mesh 精加工刀路已生成，右侧停留在原始3D模型并叠加刀路线" : "Mesh 360° 表面采样刀路已生成，右侧停留在原始3D模型并叠加刀路线");
        finishTaskJob(jobId, "done", `完成：${data.points.length} 点，估算 ${data.estimatedMinutes.toFixed(1)} min。`);
        recordTask({
          category: "cam",
          status: data.summary.warnings.length > 0 ? "warning" : "ok",
          title: baseSettings.camMode === "3axis" ? "生成 Mesh 三轴刀路" : baseSettings.camMode === "rotaryWrap" ? "生成 Mesh 旋转包裹刀路" : finishing ? "生成 Mesh 精加工刀路" : "生成 Mesh 四轴刀路",
          detail: `点数 ${data.points.length}，估算 ${data.estimatedMinutes.toFixed(1)} min，警告 ${data.summary.warnings.length} 条。`
        });
      } catch (error) {
        setAiMeshStatus(error instanceof Error ? error.message : "Mesh CAM 刀路生成失败");
        finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh CAM 刀路生成失败");
        recordTask({
          category: "cam",
          status: "error",
          title: "Mesh CAM 刀路生成失败",
          detail: error instanceof Error ? error.message : "未知错误"
        });
      } finally {
        setIsToolpathGenerating(false);
      }
      return;
    }

    const localJobId = startTaskJob({
      category: "cam",
      title: finishing ? "本地精加工刀路" : "本地粗精清残刀路",
      detail: "正在生成粗加工、精加工、清残和空跑程序。",
      retryAction: finishing ? "generate-finish-toolpath" : "generate-toolpath"
    });
    appendTaskJobLog(localJobId, "读取当前深度场与工艺参数。", 28);
    const generatedToolpath = generateToolpath(processedDepth, baseSettings);
    if (isTaskJobCanceled(localJobId)) return;
    appendTaskJobLog(localJobId, "刀路计算完成，正在生成仿真与质量指标。", 88);
    setToolpath(generatedToolpath);
    setToolpathKind(finishing ? "finish" : "rough");
    setIsSimulationMode(true);
    setWorkbenchView("simulation");
    saveSnapshot(finishing ? "本地精加工刀路" : "本地粗精刀路", baseSettings, `点数 ${generatedToolpath.points.length}，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min。`);
    finishTaskJob(localJobId, "done", `完成：${generatedToolpath.points.length} 点，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min。`);
    recordTask({
      category: "cam",
      status: generatedToolpath.summary.warnings.length > 0 ? "warning" : "ok",
      title: finishing ? "生成本地精加工刀路" : "生成本地粗精加工刀路",
      detail: `点数 ${generatedToolpath.points.length}，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min，粗加工 ${generatedToolpath.programs?.rough?.estimatedMinutes.toFixed(1) ?? "-"} min，清残 ${generatedToolpath.programs?.rest?.points.length ?? 0} 点。`
    });
  };

  const handleGenerate3D = () => {
    if (images.length === 0) {
      setGeneratedDepth(createBlankDepthMap());
      setGenerationLabel("内置示例");
    setToolpath(null);
    setIsSimulationMode(false);
    return;
    }

    const depth =
      settings.generationMode === "multiview"
        ? createMultiViewDepthMap(images.map((image) => image.depthMap))
        : settings.generationMode === "blend"
          ? blendDepthMaps(images.map((image) => image.depthMap))
          : (activeImage?.depthMap ?? images[0].depthMap);

    setGeneratedDepth(depth);
    releaseImportedModelObjectUrl();
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setOriginalModelFileName(null);
    setMeshQuality(null);
    setAiMeshStatus("未生成");
    if (settings.generationMode === "multiview") {
      setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
      setGenerationLabel(`本地360°环绕浮雕：${images.length}张图片`);
      recordTask({
        category: "model",
        status: "ok",
        title: "生成本地 360° 环绕浮雕",
        detail: `使用 ${images.length} 张图片生成本地环绕深度场。`
      });
    } else {
      setGenerationLabel(settings.generationMode === "blend" ? `多图融合：${images.length}张图片` : `当前图片：${activeImage?.name ?? images[0].name}`);
      recordTask({
        category: "model",
        status: "ok",
        title: settings.generationMode === "blend" ? "生成多图融合浮雕" : "生成单图浮雕",
        detail: settings.generationMode === "blend" ? `融合 ${images.length} 张图片。` : `使用 ${activeImage?.name ?? images[0].name}。`
      });
    }
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleDepthEdit = (depth: DepthMap) => {
    setGeneratedDepth(depth);
    releaseImportedModelObjectUrl();
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setOriginalModelFileName(null);
    setMeshQuality(null);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleClearAiMesh = () => {
    releaseImportedModelObjectUrl();
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setOriginalModelFileName(null);
    setMeshQuality(null);
    setAiMeshStatus("未生成");
    setGenerationLabel(generatedDepth ? "本地浮雕网格" : images.length > 0 ? "图片已载入，待生成3D" : "内置示例");
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleLoadDemoImages = () => {
    const demos = [
      { name: "内置莲纹示例", depthMap: createDemoDepthMap("lotus") },
      { name: "内置云纹示例", depthMap: createDemoDepthMap("waves") }
    ].map((demo) => ({
      ...demo,
      id: `${demo.name}-${crypto.randomUUID()}`,
      url: depthMapToPreviewUrl(demo.depthMap),
      quality: analyzeDepthMapQuality(demo.depthMap)
    }));

    setImages(demos);
    setActiveId(demos[0].id);
    setGeneratedDepth(null);
    releaseImportedModelObjectUrl();
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setOriginalModelFileName(null);
    setMeshQuality(null);
    setGenerationLabel("示例图案已载入，待生成3D");
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    recordTask({
      category: "source",
      status: "ok",
      title: "载入示例图案",
      detail: "已载入内置莲纹和云纹示例。"
    });
  };

  const handleLoadMaterial01 = async () => {
    setIsReading(true);
    try {
      const filenames = ["0.png", "1.png", "2.png", "3.png", "4.png", "5.png"];
      const loaded = await Promise.all(
        filenames.map(async (name) => {
          const url = `/test-assets/01/${name}`;
          const result = await assetUrlToDepthMap(url);
          return {
            id: `素材01-${name}-${crypto.randomUUID()}`,
            name: `素材01/${name}`,
            quality: analyzeDepthMapQuality(result.depthMap),
            ...result
          };
        })
      );

      setImages(loaded);
      setActiveId(loaded[0].id);
      setGeneratedDepth(null);
      releaseImportedModelObjectUrl();
      setAiMeshUrl(null);
      setAiMeshStlUrl(null);
      setOriginalModelFileName(null);
      setMeshQuality(null);
      setGenerationLabel("素材01已载入，待生成3D");
      setToolpath(null);
      setIsSimulationMode(false);
      setWorkbenchView("model");
      recordTask({
        category: "source",
        status: "ok",
        title: "载入素材01",
        detail: `已载入 ${loaded.length} 张测试素材，首张质量评分 ${loaded[0].quality?.score.toFixed(1) ?? "-"}。`
      });
    } finally {
      setIsReading(false);
    }
  };

  const handleGenerateAiMesh = async () => {
    if (images.length === 0) {
      setAiMeshStatus("请先上传图片或载入素材");
      return;
    }
    if (!isProviderAvailable(selectedAiProvider)) {
      setAiMeshStatus(`${selectedAiProvider.name} 尚未接入，当前请选择 Meshy 生成。`);
      recordTask({
        category: "model",
        status: "warning",
        title: "AI Provider 未接入",
        detail: `${selectedAiProvider.name} 已预留接口，但还没有可调用的后端服务。`
      });
      return;
    }

    setIsAiGenerating(true);
    releaseImportedModelObjectUrl();
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setOriginalModelFileName(null);
    setMeshQuality(null);
    setToolpath(null);
    const selected = images.slice(0, selectedAiProvider.maxImages);
    const jobId = startTaskJob({
      category: "model",
      title: `${selectedAiProvider.name} 生成 3D Mesh`,
      detail: `正在上传 ${selected.length} 张图片并等待 AI 3D 任务完成。`,
      retryAction: "generate-ai-mesh"
    });

    try {
      setAiMeshStatus(`准备上传 ${selected.length} 张图片到 ${selectedAiProvider.name}`);
      appendTaskJobLog(jobId, `准备 ${selected.length} 张输入图。`, 18);
      const imageUrls = await Promise.all(selected.map((image) => imageToDataUri(image.url)));
      if (isTaskJobCanceled(jobId)) return;

      setAiMeshStatus(`已提交 ${selectedAiProvider.name} 任务，等待排队`);
      appendTaskJobLog(jobId, "图片已转换，正在创建远端 AI 任务。", 32);
      const createResponse = await fetch(selectedAiProvider.endpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: imageUrls,
          target_formats: selectedAiProvider.targetFormats
        })
      });

      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? `${selectedAiProvider.name}任务创建失败`);
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) {
        throw new Error(`${selectedAiProvider.name}响应中没有任务ID`);
      }

      appendTaskJobLog(jobId, `远端任务已创建：${taskId}`, 45);
      const task = await pollAi3dTask(selectedAiProvider.taskEndpoint!(taskId), setAiMeshStatus, `${selectedAiProvider.name}任务`);
      if (isTaskJobCanceled(jobId)) return;
      const glb = task.local_model_urls?.glb ?? task.model_urls?.glb ?? task.output?.model_urls?.glb ?? task.model_url;
      const stl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!glb) {
        throw new Error(`${selectedAiProvider.name}任务已完成，但没有返回GLB模型地址`);
      }

      setAiMeshUrl(glb);
      setAiMeshStlUrl(stl ?? null);
      setOriginalModelFileName(null);
      setModelSubStage(stl ? "inspection" : "ai");
      setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
      setGenerationLabel(`${selectedAiProvider.name} AI 3D Mesh：${selected.length}张图片`);
      setAiMeshStatus(task.local_model_urls?.glb ? `${selectedAiProvider.name} 3D Mesh 生成完成，已缓存到本地` : `${selectedAiProvider.name} 3D Mesh 生成完成`);
      appendTaskJobLog(jobId, "AI Mesh 文件已返回，正在载入预览。", 92);
      finishTaskJob(jobId, "done", `完成：生成 GLB${stl ? "/STL" : ""}，输入 ${selected.length} 张图片。`);
      recordTask({
        category: "model",
        status: stl ? "ok" : "warning",
        title: `${selectedAiProvider.name} 生成 3D Mesh`,
        detail: `使用 ${selected.length} 张图片生成 GLB${stl ? "/STL" : ""}。`
      });
    } catch (error) {
      const message = formatRequestError(error, `${selectedAiProvider.name}生成失败`);
      setAiMeshStatus(message);
      finishTaskJob(jobId, "error", message);
      recordTask({
        category: "model",
        status: "error",
        title: `${selectedAiProvider.name} 生成失败`,
        detail: message
      });
    } finally {
      setIsAiGenerating(false);
    }
  };

  const handleLoadLocalMeshyResult = () => {
    releaseImportedModelObjectUrl();
    setAiMeshUrl("/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.glb");
    setAiMeshStlUrl("/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.stl");
    setOriginalModelFileName(null);
    setModelSubStage("inspection");
    setMeshQuality(null);
    setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
    setGenerationLabel("AI 3D Mesh：素材01测试结果");
    setAiMeshStatus("已载入本地 Meshy 测试结果");
    setToolpath(null);
    setIsSimulationMode(false);
    recordTask({
      category: "model",
      status: "ok",
      title: "载入 Meshy 测试结果",
      detail: "已载入本地 GLB/STL 测试模型。"
    });
  };

  const handleRepairMesh = async () => {
    if (!aiMeshStlUrl) {
      setAiMeshStatus("当前没有可修复的本地 STL，请先生成或载入 Meshy 模型");
      return;
    }

    setIsMeshRepairing(true);
    setAiMeshStatus("正在提交 Meshy 可制造性修复任务");
    const jobId = startTaskJob({
      category: "model",
      title: "Mesh 缺损修复",
      detail: "正在提交 Meshy Repair Printability 并等待修复 STL。",
      retryAction: "repair-mesh"
    });
    try {
      appendTaskJobLog(jobId, "提交 Meshy Repair Printability 请求。", 24);
      const createResponse = await fetch("/api/meshy/repair-printability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stlUrl: aiMeshStlUrl })
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? "Mesh 修复任务创建失败");
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) throw new Error("Mesh 修复响应中没有任务ID");

      appendTaskJobLog(jobId, `修复任务已创建：${taskId}`, 42);
      const task = await pollMeshyTaskByEndpoint(`/api/meshy/repair-printability/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh修复");
      if (isTaskJobCanceled(jobId)) return;
      const repairedStl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!repairedStl) throw new Error("Mesh 修复完成，但没有返回 STL");

      setAiMeshStlUrl(repairedStl);
      setOriginalModelFileName(null);
      setMeshQuality(null);
      setToolpath(null);
      setIsSimulationMode(false);
      setAiMeshStatus("Mesh 缺损修复完成，已替换刀路用 STL，请重新生成刀路");
      appendTaskJobLog(jobId, "修复 STL 已返回，已替换刀路输入模型。", 92);
      finishTaskJob(jobId, "done", "完成：已替换刀路用 STL。");
      recordTask({
        category: "model",
        status: "ok",
        title: "Mesh 缺损修复完成",
        detail: "已替换刀路用 STL，请重新生成刀路并查看未命中点。"
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 修复失败");
      finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh 修复失败");
      recordTask({
        category: "model",
        status: "error",
        title: "Mesh 修复失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
    } finally {
      setIsMeshRepairing(false);
    }
  };

  const handleRemesh = async () => {
    const sourceModel = aiMeshUrl?.startsWith("/meshy-results/") ? aiMeshUrl : aiMeshStlUrl;
    if (!sourceModel) {
      setAiMeshStatus("当前没有可重建的本地 Meshy 模型");
      return;
    }

    setIsMeshRepairing(true);
    setAiMeshStatus("正在提交 Meshy 重网格任务");
    const jobId = startTaskJob({
      category: "model",
      title: "Mesh 重网格",
      detail: "正在提交 Meshy Remesh 并等待可雕刻网格。",
      retryAction: "remesh"
    });
    try {
      appendTaskJobLog(jobId, "提交 Meshy Remesh 请求。", 24);
      const createResponse = await fetch("/api/meshy/remesh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelUrl: sourceModel })
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? "Mesh 重网格任务创建失败");
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) throw new Error("Mesh 重网格响应中没有任务ID");

      appendTaskJobLog(jobId, `重网格任务已创建：${taskId}`, 42);
      const task = await pollMeshyTaskByEndpoint(`/api/meshy/remesh/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh重网格");
      if (isTaskJobCanceled(jobId)) return;
      const remeshGlb = task.local_model_urls?.glb ?? task.model_urls?.glb ?? task.output?.model_urls?.glb ?? task.model_url;
      const remeshStl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!remeshGlb && !remeshStl) throw new Error("Mesh 重网格完成，但没有返回模型文件");

      releaseImportedModelObjectUrl();
      if (remeshGlb) setAiMeshUrl(remeshGlb);
      if (remeshStl) setAiMeshStlUrl(remeshStl);
      setOriginalModelFileName(null);
      setMeshQuality(null);
      setGenerationLabel("AI 3D Mesh：已重建可雕刻网格");
      setToolpath(null);
      setIsSimulationMode(false);
      setAiMeshStatus("Mesh 重网格完成，已替换当前模型，请重新生成刀路");
      appendTaskJobLog(jobId, "重网格模型已返回，正在更新当前模型。", 92);
      finishTaskJob(jobId, "done", `完成：${remeshGlb ? "GLB" : ""}${remeshGlb && remeshStl ? "/" : ""}${remeshStl ? "STL" : ""} 已替换。`);
      recordTask({
        category: "model",
        status: "ok",
        title: "Mesh 重网格完成",
        detail: "已替换当前模型，请重新生成刀路。"
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 重网格失败");
      finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh 重网格失败");
      recordTask({
        category: "model",
        status: "error",
        title: "Mesh 重网格失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
    } finally {
      setIsMeshRepairing(false);
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="brand">
          <div className="brand-mark">
            <Box size={22} />
          </div>
          <div>
            <h1>核雕3D CAM</h1>
            <p>三轴旋转夹具试雕闭环</p>
          </div>
        </section>

        <nav className="workflow-nav" aria-label="V2 workflow stages">
          {workflowStages.map((stage) => (
            <button className={stage.id === activeStage ? "active" : ""} key={stage.id} onClick={() => setActiveStage(stage.id)} type="button">
              <strong>{stage.label}</strong>
              <span>{stage.hint}</span>
            </button>
          ))}
        </nav>

        {activeStage === "project" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Library size={18} />
                <h2>项目档案</h2>
              </div>
              <p className="panel-note">把客户、项目编号、素材、模型、刀路和反馈绑定在一起，导出包和任务记录可追溯。</p>
              <label className="field-control">
                <span>项目名称</span>
                <input value={projectProfile.projectName} onChange={(event) => updateProjectProfile("projectName", event.target.value)} />
              </label>
              <label className="field-control">
                <span>客户名称</span>
                <input value={projectProfile.customerName} onChange={(event) => updateProjectProfile("customerName", event.target.value)} />
              </label>
              <label className="field-control">
                <span>项目编号</span>
                <input value={projectProfile.projectCode} onChange={(event) => updateProjectProfile("projectCode", event.target.value)} />
              </label>
              <label className="select-row">
                <span>当前角色</span>
                <select value={projectProfile.role} onChange={(event) => updateProjectProfile("role", event.target.value as UserRole)}>
                  <option value="admin">管理员</option>
                  <option value="designer">设计员</option>
                  <option value="process">工艺员</option>
                  <option value="operator">操作员</option>
                </select>
              </label>
              <div className={`permission-card ${projectProfile.role}`}>
                <strong>{formatUserRole(projectProfile.role)}</strong>
                <span>{getRolePermissionText(projectProfile.role)}</span>
              </div>
              <button className="primary-action package-action" type="button" onClick={handleSaveProjectProfile}>
                <Save size={17} />
                保存项目档案
              </button>
              {!V3_TRIAL_FOCUSED_UI && (
                <button className="demo-action package-action" type="button" onClick={handleArchiveProject}>
                  <Library size={17} />
                  归档当前项目
                </button>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>项目状态</h2>
              </div>
              <div className="project-summary">
                <span><strong>{images.length}</strong> 素材</span>
                <span><strong>{aiMeshUrl ? "AI Mesh" : generatedDepth ? "浮雕" : "待建模"}</strong> 模型</span>
                <span><strong>{toolpath ? toolpath.points.length.toLocaleString() : "-"}</strong> 刀路点</span>
                <span><strong>{exportGateReady ? "已解锁" : "未解锁"}</strong> 导出</span>
              </div>
            </section>

            {!V3_TRIAL_FOCUSED_UI && <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>项目归档</h2>
              </div>
              {projectArchives.length === 0 ? (
                <p className="panel-note">还没有归档记录。完成建模、刀路或反馈后，可以把当前项目状态保存为一条生产记录。</p>
              ) : (
                <div className="project-archive-list">
                  {projectArchives.map((archive) => (
                    <div className={`project-archive-card ${archive.exportReady ? "ready" : "review"}`} key={archive.id}>
                      <div>
                        <strong>{archive.projectName}</strong>
                        <span>{archive.createdAt}</span>
                      </div>
                      <p>{archive.customerName} / {archive.projectCode}</p>
                      <small>{archive.machineName} / {archive.toolName} / {archive.hasToolpath ? "已有刀路" : "未生成刀路"} / 反馈 {archive.feedbackCount}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>}
          </>
        )}

        {activeStage === "source" && (
          <>
            <label className="upload-panel">
              <UploadCloud size={24} />
              <span>{isReading ? "正在读取图片..." : "上传一张或多张核雕图片"}</span>
              <input type="file" accept="image/*" multiple onChange={handleFiles} disabled={isReading} />
            </label>
            {!V3_TRIAL_FOCUSED_UI && (
              <button className="demo-action" onClick={handleLoadDemoImages} type="button">
                <Sparkles size={17} />
                载入示例图案
              </button>
            )}
            <button className="demo-action material-action" onClick={handleLoadMaterial01} type="button" disabled={isReading}>
              <FileImage size={17} />
              载入素材01
            </button>
          </>
        )}

        {activeStage === "source" && images.length > 0 && (
          <section className="panel">
            <div className="panel-title">
              <Camera size={18} />
              <h2>采集向导</h2>
            </div>
            <div className={`capture-summary ${captureGuide.verdict}`}>
              <strong>{captureGuide.score.toFixed(1)}</strong>
              <span>{captureGuide.summary}</span>
            </div>
            <div className="capture-slots">
              {captureGuide.slots.map((slot, index) => (
                <button
                  className={`capture-slot ${slot.status}`}
                  key={slot.label}
                  type="button"
                  disabled={!images[index]}
                  onClick={() => {
                    if (images[index]) setActiveId(images[index].id);
                  }}
                >
                  <span>{slot.label}</span>
                  <strong>{slot.imageName ?? "待补拍"}</strong>
                  <small>{slot.hint}</small>
                  <em>{slot.retakeAction}</em>
                </button>
              ))}
            </div>
            <div className="capture-retake-plan">
              {captureGuide.slots
                .filter((slot) => slot.status !== "ready")
                .map((slot) => (
                  <div className={slot.status} key={`${slot.label}-plan`}>
                    <strong>{slot.label} {slot.angleDeg}°：{slot.issue}</strong>
                    <span>{slot.retakeAction}</span>
                  </div>
                ))}
            </div>
            <div className="quality-notes">
              {captureGuide.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {activeStage === "source" && images.length > 0 && (
          <section className="panel">
            <div className="panel-title">
              <FileImage size={18} />
              <h2>图片素材</h2>
            </div>
            <div className="thumb-grid">
              {images.map((image) => (
                <button
                  className={`thumb ${image.id === activeImage?.id ? "active" : ""}`}
                  key={image.id}
                  onClick={() => {
                    setActiveId(image.id);
                    setToolpath(null);
                  }}
                  title={image.name}
                >
                  <img src={image.url} alt={image.name} />
                </button>
              ))}
            </div>
          </section>
        )}

        {activeStage === "source" && activeQuality && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>采集质量检测</h2>
            </div>
            <div className={`quality-score ${activeQuality.verdict}`}>
              <strong>{activeQuality.score.toFixed(1)}</strong>
              <span>{activeQuality.summary}</span>
            </div>
            <div className="quality-grid">
              {activeQuality.metrics.map((metric) => (
                <div className={`quality-metric ${metric.status}`} key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value.toFixed(metric.unit === "%" ? 1 : 2)}{metric.unit}</strong>
                </div>
              ))}
            </div>
            <div className="quality-notes">
              {activeQuality.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {activeStage === "model" && (
          <>
            <div className="stage-subtabs" role="tablist" aria-label="model stage sections">
              {!V3_TRIAL_FOCUSED_UI && <button className={modelSubStage === "local" ? "active" : ""} type="button" onClick={() => setModelSubStage("local")}>本地建模</button>}
              <button className={modelSubStage === "ai" ? "active" : ""} type="button" onClick={() => setModelSubStage("ai")}>AI Mesh</button>
              <button className={modelSubStage === "inspection" ? "active" : ""} type="button" onClick={() => setModelSubStage("inspection")}>Mesh体检</button>
            </div>

            {!V3_TRIAL_FOCUSED_UI && modelSubStage === "local" && <section className="panel">
              <div className="panel-title">
                <Layers3 size={18} />
                <h2>生成控制</h2>
              </div>
              <label className="select-row">
                <span>生成模式</span>
                <select value={settings.generationMode} onChange={(event) => updateSetting("generationMode", event.target.value as ModelSettings["generationMode"])} disabled={images.length < 2}>
                  <option value="active">当前选中图片</option>
                  <option value="blend">多图平均融合</option>
                  <option value="multiview">本地360°环绕浮雕（非AI Mesh）</option>
                </select>
              </label>
              <button className="primary-action generate-3d" onClick={handleGenerate3D}>
                <Layers3 size={18} />
                3D生成
              </button>
            </section>}

            {modelSubStage === "ai" && <section className="panel">
              <div className="panel-title">
                <Sparkles size={18} />
                <h2>推荐：真实3D网格</h2>
              </div>
              <p className="panel-note">主流程只保留 Meshy 多图生成和原始 GLB/STL 导入，生成真正三维网格后进入 V3 安全试雕闭环。</p>
              {!V3_TRIAL_FOCUSED_UI && <label className="select-row">
                <span>AI Provider</span>
                <select value={aiProviderId} onChange={(event) => setAiProviderId(event.target.value as Ai3dProviderId)}>
                  {visibleAiProviders.map((provider) => (
                    <option value={provider.id} key={provider.id}>
                      {provider.name}{provider.status === "available" ? "（已接入）" : provider.status === "local" ? "（本地预留）" : "（预留）"}
                    </option>
                  ))}
                </select>
              </label>}
              <div className={`provider-card ${selectedAiProvider.status}`}>
                <strong>{selectedAiProvider.name}</strong>
                <span>{selectedAiProvider.note}</span>
                <small>{selectedAiProvider.capabilities.join(" / ")}</small>
              </div>
              {!V3_TRIAL_FOCUSED_UI && <div className="provider-compare-grid">
                {ai3dProviders.map((provider) => {
                  const score = scoreAiProvider(provider, images.length, captureGuide.score);
                  return (
                    <button
                      className={`provider-compare-card ${provider.status} ${provider.id === aiProviderId ? "active" : ""}`}
                      key={provider.id}
                      type="button"
                      onClick={() => setAiProviderId(provider.id)}
                    >
                      <span>
                        <strong>{provider.name}</strong>
                        <b>{formatProviderStatus(provider.status)}</b>
                      </span>
                      <small>{provider.bestFor}</small>
                      <em>{formatProviderScore(score)} / {provider.maxImages}图 / {provider.targetFormats.join("+")}</em>
                      <i>{formatProviderTraits(provider)}</i>
                    </button>
                  );
                })}
              </div>}
              <button className="primary-action ai-action" onClick={handleGenerateAiMesh} disabled={isAiGenerating || images.length === 0}>
                <Sparkles size={18} />
                {isAiGenerating ? "AI生成中..." : `${selectedAiProvider.name}生成3D Mesh`}
              </button>
              {images.length === 0 && (
                <p className="panel-hint">Meshy 多图生成需要先在“素材”页上传图片；如果已经有佛头 GLB/STL/OBJ，可直接点下面“导入原始3D模型”。</p>
              )}
              <div className="ai-tool-grid">
                <button className="demo-action original-model-action ai-tool-wide" onClick={() => originalModelImportRef.current?.click()} type="button">
                  <UploadCloud size={17} />
                  导入原始3D模型
                </button>
                <input
                  ref={originalModelImportRef}
                  className="hidden-file-input"
                  type="file"
                  accept=".stl,.obj,.glb,.gltf,model/stl,model/obj,model/gltf-binary,model/gltf+json"
                  onChange={handleImportOriginalModelFile}
                />
                {V3_TRIAL_FOCUSED_UI && <button className="demo-action material-action ai-tool-wide" onClick={handleLoadLocalMeshyResult} type="button">
                  <FileImage size={17} />
                  载入佛头测试模型
                </button>}
                {!V3_TRIAL_FOCUSED_UI && <button className="demo-action material-action" onClick={handleLoadLocalMeshyResult} type="button">
                  <FileImage size={17} />
                  载入测试结果
                </button>}
                <button className="demo-action repair-action" onClick={handleRepairMesh} type="button" disabled={!aiMeshStlUrl || isMeshRepairing || isOriginalModelSource}>
                  <Sparkles size={17} />
                  {isMeshRepairing ? "修复中..." : "修复缺损"}
                </button>
                <button className="demo-action repair-action ai-tool-wide" onClick={handleRemesh} type="button" disabled={!aiMeshUrl || isMeshRepairing || isOriginalModelSource}>
                  <Layers3 size={17} />
                  重建可雕刻网格
                </button>
              </div>
              <div className="ai-status">{aiMeshStatus}</div>
              {aiMeshUrl && (
                <div className={`model-cam-readiness ${isModelReadyForCam ? "ready" : "pending"}`}>
                  <strong>{isModelReadyForCam ? "后端 CAM 可读取" : "仅本地预览"}</strong>
                  <span>
                    {isModelReadyForCam
                      ? "模型已缓存为后端可访问文件，可以进入 V3 试雕刀路生成。"
                      : "右侧可以先查看模型；上传缓存完成前不能生成刀路。"}
                  </span>
                  {isModelReadyForCam && (
                    <button className="demo-action package-action" type="button" onClick={() => setActiveStage("cam")}>
                      <Hammer size={17} />
                      去生成试雕刀路
                    </button>
                  )}
                </div>
              )}
              {aiMeshUrl && (
                <div className="ai-links">
                  <button type="button" onClick={() => handleDownloadModelAsset(aiMeshUrl, isOriginalModelSource ? originalModelFileName ?? "original-model.glb" : "ai-mesh.glb")}>
                    {isOriginalModelSource ? "下载原始模型" : "下载 GLB"}
                  </button>
                  {aiMeshStlUrl && (
                    <button type="button" onClick={() => handleDownloadModelAsset(aiMeshStlUrl, isOriginalModelSource ? originalModelFileName ?? "original-model.stl" : "ai-mesh.stl")}>
                      {isOriginalModelSource ? "下载 STL" : "下载 AI STL"}
                    </button>
                  )}
                </div>
              )}
            </section>}

            {modelSubStage === "inspection" && <section className="panel">
              <div className="panel-title">
                <ShieldCheck size={18} />
                <h2>Mesh质量体检</h2>
              </div>
              {!aiMeshStlUrl ? (
                <p className="panel-note">载入或生成带 STL 的 Meshy 模型后，会自动检查封闭性、非流形边、退化面和模型尺寸。</p>
              ) : meshQuality ? (
                <>
                  <div className={`quality-score ${meshQuality.verdict === "ready" ? "ready" : meshQuality.verdict === "review" ? "usable" : "retake"}`}>
                    <strong>{meshQuality.score.toFixed(1)}</strong>
                    <span>{meshQuality.verdict === "ready" ? "Mesh 可进入刀路生成" : meshQuality.verdict === "review" ? "Mesh 建议复核后加工" : "Mesh 建议先修复"}</span>
                  </div>
                  <div className="mesh-stats">
                    <span>面数 <strong>{meshQuality.triangleCount.toLocaleString()}</strong></span>
                    <span>边界边 <strong>{meshQuality.boundaryEdges}</strong></span>
                    <span>非流形 <strong>{meshQuality.nonManifoldEdges}</strong></span>
                    <span>长轴 <strong>{meshQuality.detectedLongAxis.toUpperCase()}</strong></span>
                    <span>尺寸 <strong>{meshQuality.dimensions.x.toFixed(1)} x {meshQuality.dimensions.y.toFixed(1)} x {meshQuality.dimensions.z.toFixed(1)}</strong></span>
                  </div>
                  <div className="inspection-list">
                    {meshQuality.checks.map((check) => (
                      <div className={`inspection-item ${check.status}`} key={check.label}>
                        <div>
                          <span>{check.label}</span>
                          <strong>{check.value}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                  {meshQuality.regions && (
                    <div className="mesh-region-grid">
                      {meshQuality.regions.map((region) => (
                        <div className={`mesh-region ${region.status}`} key={region.label}>
                          <span>{region.label}</span>
                          <strong>{region.riskScore}</strong>
                          <small>{region.detail}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="quality-notes">
                    {meshQuality.recommendations.map((recommendation) => (
                      <span key={recommendation}>{recommendation}</span>
                    ))}
                  </div>
                  {meshCalibrationGuide && (
                    <div className="mesh-calibration-guide">
                      <div className={`mesh-calibration-verdict ${meshCalibrationGuide.status}`}>
                        <strong>{meshCalibrationGuide.title}</strong>
                        <span>{meshCalibrationGuide.detail}</span>
                      </div>
                      <div className="mesh-calibration-steps">
                        {meshCalibrationGuide.steps.map((step) => (
                          <div className={step.status} key={step.label}>
                            <span>{step.label}</span>
                            <strong>{step.value}</strong>
                            <small>{step.detail}</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="calibration-controls">
                    <label className="select-row">
                      <span>CAM长轴</span>
                      <select value={settings.meshLengthAxis} onChange={(event) => updateSetting("meshLengthAxis", event.target.value as ModelSettings["meshLengthAxis"])}>
                        <option value="auto">自动识别</option>
                        <option value="x">X 轴</option>
                        <option value="y">Y 轴</option>
                        <option value="z">Z 轴</option>
                      </select>
                    </label>
                    <label className="toggle-row">
                      <input type="checkbox" checked={settings.meshAxisReverse} onChange={(event) => updateSetting("meshAxisReverse", event.target.checked)} />
                      <span>反转长轴采样方向</span>
                    </label>
                    <button className="demo-action" type="button" onClick={() => updateSetting("meshLengthAxis", meshQuality.detectedLongAxis)}>
                      <Layers3 size={17} />
                      采用体检长轴 {meshQuality.detectedLongAxis.toUpperCase()}
                    </button>
                    <button className="demo-action" type="button" onClick={handleApplyMeshDimensions}>
                      <SlidersHorizontal size={17} />
                      同步 Mesh 尺寸
                    </button>
                  </div>
                  <div className="repair-steps">
                    <div className={meshQuality.boundaryEdges > 0 ? "active" : ""}>
                      <strong>1. 修复缺损</strong>
                      <span>优先处理孔洞、开口和打印可制造性。</span>
                    </div>
                    <div className={meshQuality.nonManifoldEdges > 0 || meshQuality.degenerateFaces > 0 ? "active" : ""}>
                      <strong>2. 重建可雕刻网格</strong>
                      <span>处理非流形边、退化面和网格密度不均。</span>
                    </div>
                    <div>
                      <strong>3. 重新生成刀路</strong>
                      <span>修复后重新采样并查看未命中点变化。</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="ai-status">{meshQualityStatus}</div>
              )}
            </section>}
          </>
        )}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <Sparkles size={18} />
              <h2>工艺模板</h2>
            </div>
            <p className="panel-note">按加工目标一键套用刀具、材料、进给、步距、切深和精修策略。应用后会清空旧刀路，并保存参数快照。</p>
            <div className="template-toolbar">
              <button className="demo-action" type="button" onClick={handleSaveCustomProcessTemplate}>
                <Save size={16} />
                保存当前为模板
              </button>
              <button className="demo-action" type="button" onClick={handleExportCustomProcessTemplates}>
                <Download size={16} />
                导出模板
              </button>
              <button className="demo-action" type="button" onClick={() => processTemplateImportRef.current?.click()}>
                <UploadCloud size={16} />
                导入模板
              </button>
              <input ref={processTemplateImportRef} className="hidden-file-input" type="file" accept="application/json,.json" onChange={handleImportCustomProcessTemplates} />
              <span>{customProcessTemplates.length}/16 个自定义模板</span>
            </div>
            <div className="template-section-title">
              <strong>内置模板</strong>
              <span>低风险、快速验证、标准核雕和高精细场景</span>
            </div>
            <div className="template-grid">
              {processTemplates.map((template) => (
                <button className="template-card" type="button" key={template.id} onClick={() => handleProcessTemplateChange(template.id)}>
                  <strong>{template.name}</strong>
                  <span>{template.intent}</span>
                  <small>{template.notes}</small>
                </button>
              ))}
            </div>
            <div className="template-section-title">
              <strong>自定义模板</strong>
              <span>保存在当前浏览器，用于复用试雕成功参数</span>
            </div>
            {customProcessTemplates.length > 0 ? (
              <div className="template-grid custom-template-grid">
                {customProcessTemplates.map((template) => (
                  <div className="template-card custom-template-card" key={template.id}>
                    <button className="template-apply" type="button" onClick={() => handleProcessTemplateChange(template.id)}>
                      <strong>{template.name}</strong>
                      <span>{template.intent}</span>
                      <small>{template.notes}</small>
                    </button>
                    <button className="template-delete" type="button" onClick={() => handleDeleteCustomProcessTemplate(template.id)} title="删除自定义模板" aria-label={`删除 ${template.name}`}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-inline">还没有自定义模板。调整好刀具、材料、步距和进给后，可保存当前参数。</p>
            )}
          </section>
        )}

        {activeStage === "process" && <section className="panel">
          <div className="panel-title">
            <SlidersHorizontal size={18} />
            <h2>3D微调</h2>
          </div>
          <Control label="核长" value={settings.lengthMm} min={18} max={70} step={0.5} suffix="mm" onChange={(v) => updateSetting("lengthMm", v)} />
          <Control label="最大直径" value={settings.diameterMm} min={8} max={28} step={0.2} suffix="mm" onChange={(v) => updateSetting("diameterMm", v)} />
          <Control label="浮雕深度" value={settings.depthMm} min={0.1} max={2.5} step={0.05} suffix="mm" onChange={(v) => updateSetting("depthMm", v)} />
          <Control label="包覆角度" value={settings.reliefAngleDeg} min={60} max={360} step={5} suffix="°" onChange={(v) => updateSetting("reliefAngleDeg", v)} />
          <Control label="图像对比" value={settings.contrast} min={0.5} max={3} step={0.05} suffix="x" onChange={(v) => updateSetting("contrast", v)} />
          <Control label="平滑次数" value={settings.smoothPasses} min={0} max={5} step={1} suffix="" onChange={(v) => updateSetting("smoothPasses", v)} />
          <label className="toggle-row">
            <input type="checkbox" checked={settings.invertDepth} onChange={(event) => updateSetting("invertDepth", event.target.checked)} />
            <span>反转深浅</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} />
            <span>显示网格</span>
          </label>
        </section>}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <SlidersHorizontal size={18} />
              <h2>毛坯截面标定</h2>
            </div>
            <p className="panel-note">真实核胚通常不是标准圆柱。用 5 个截面近似毛坯外形，用于风险提示、报告和后续刀路补偿。</p>
            <Control label="左端直径" value={settings.blankLeftDiameterMm} min={6} max={30} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankLeftDiameterMm", v)} />
            <Control label="左肩直径" value={settings.blankLeftMidDiameterMm} min={6} max={32} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankLeftMidDiameterMm", v)} />
            <Control label="中部直径" value={settings.blankCenterDiameterMm} min={6} max={32} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankCenterDiameterMm", v)} />
            <Control label="右肩直径" value={settings.blankRightMidDiameterMm} min={6} max={32} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankRightMidDiameterMm", v)} />
            <Control label="右端直径" value={settings.blankRightDiameterMm} min={6} max={30} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankRightDiameterMm", v)} />
            <div className="blank-profile">
              <span>左 {settings.blankLeftDiameterMm.toFixed(1)}mm</span>
              <span>左肩 {settings.blankLeftMidDiameterMm.toFixed(1)}mm</span>
              <strong>中 {settings.blankCenterDiameterMm.toFixed(1)}mm</strong>
              <span>右肩 {settings.blankRightMidDiameterMm.toFixed(1)}mm</span>
              <span>右 {settings.blankRightDiameterMm.toFixed(1)}mm</span>
            </div>
            <div className="blank-template-actions">
              <button className="mini-action" type="button" onClick={() => applyBlankProfileTemplate("standard")}>标准核胚</button>
              <button className="mini-action" type="button" onClick={() => applyBlankProfileTemplate("tapered")}>两端收尖</button>
              <button className="mini-action" type="button" onClick={() => applyBlankProfileTemplate("offset")}>偏心核胚</button>
            </div>
          </section>
        )}

        {activeStage === "process" && (aiMeshUrl ? (
          <section className="panel ai-mesh-note">
            <div className="panel-title">
              <Sparkles size={18} />
              <h2>Meshy网格查看</h2>
            </div>
            <p className="panel-note">
              当前加载的是 Meshy AI 3D Mesh。真实三维网格显示在右侧 3D 视图区；局部修模只适用于本地浮雕深度图。
            </p>
            <button className="demo-action" onClick={handleClearAiMesh} type="button">
              回到本地浮雕修模
            </button>
          </section>
        ) : (
          <DepthEditor depthMap={generatedDepth} onChange={handleDepthEdit} />
        ))}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <Library size={18} />
              <h2>工艺预设</h2>
            </div>
            <label className="select-row">
              <span>刀具</span>
              <select value={settings.toolProfileId} onChange={(event) => handleToolProfileChange(event.target.value)}>
                {toolProfiles.map((tool) => (
                  <option value={tool.id} key={tool.id}>{tool.name}</option>
                ))}
              </select>
            </label>
            <label className="select-row">
              <span>材料</span>
              <select value={settings.materialProfileId} onChange={(event) => handleMaterialProfileChange(event.target.value)}>
                {materialProfiles.map((material) => (
                  <option value={material.id} key={material.id}>{material.name}</option>
                ))}
              </select>
            </label>
            <label className="select-row">
              <span>机床</span>
              <select value={settings.machineProfileId} onChange={(event) => handleMachineProfileChange(event.target.value)}>
                {machineProfiles.map((machine) => (
                  <option value={machine.id} key={machine.id}>{machine.name}</option>
                ))}
              </select>
            </label>
            <div className="profile-summary">
              <span>
                刀具：{selectedTool.diameterMm.toFixed(2)}mm
                {selectedTool.angleDeg != null ? ` / ${selectedTool.angleDeg.toFixed(0)}°` : ""}
                {selectedTool.flatTipMm != null ? ` / 平底 ${selectedTool.flatTipMm.toFixed(2)}mm` : ""}
                {" / "}最大切深 {selectedTool.maxCutDepthMm.toFixed(2)}mm
              </span>
              <span>材料：{selectedMaterial.notes}</span>
              <span>机床：{selectedMachine.notes}</span>
            </div>
            {V3_TRIAL_FOCUSED_UI && (
              <div className="v3-machine-preset-card">
                <div>
                  <strong>当前目标机床：三轴控制器 + Y轴旋转夹具</strong>
                  <small>X 走核胚长度，Z 控制刀深，Y 输出夹具旋转等效行程；正式生产 NC 仍由 V3 证据链锁定。</small>
                </div>
                <div className="v3-machine-preset-grid">
                  <span>刀具 <strong>4mm / 25° / 平底尖刀</strong></span>
                  <span>后处理 <strong>{settings.postProcessor}</strong></span>
                  <span>每圈距离 <strong>{settings.rotaryWrapPerRevolutionMm.toFixed(0)} mm</strong></span>
                  <span>安全高度 <strong>{settings.safeZ.toFixed(1)} mm</strong></span>
                </div>
                <button className="demo-action package-action" type="button" onClick={applyRotaryYTrialPreset}>
                  <SlidersHorizontal size={17} />
                  应用保守试雕预设
                </button>
              </div>
            )}
          </section>
        )}

        {activeStage === "cam" && <section className="panel">
          <div className="panel-title">
            <Hammer size={18} />
            <h2>刀路参数</h2>
          </div>
          {V3_TRIAL_FOCUSED_UI && (
            <p className="panel-note">这些参数供 V3 小闭环生成安全试雕包使用；旧版本地生成、精加工和反向预览入口已暂时隐藏，避免误下载未验收 NC。</p>
          )}
          {V3_TRIAL_FOCUSED_UI ? (
            <div className="v3-operator-param-card">
              <div>
                <strong>已锁定目标工艺</strong>
                <small>三轴控制器 + Y轴旋转夹具，后处理固定走 wrapY 证据链；其他 CAM 模式放到工程模式。</small>
              </div>
              <div className="v3-operator-param-grid">
                <span>运动 <strong>X长度 / Y旋转 / Z刀深</strong></span>
                <span>刀具 <strong>{selectedTool.diameterMm.toFixed(1)}mm / {selectedTool.angleDeg?.toFixed(0) ?? 25}° / 平底尖刀</strong></span>
                <span>后处理 <strong>{settings.postProcessor}</strong></span>
                <span>生产 NC <strong>门禁锁定</strong></span>
              </div>
            </div>
          ) : (
            <label className="select-row">
              <span>CAM模式</span>
              <select value={settings.camMode} onChange={(event) => handleCamModeChange(event.target.value as ModelSettings["camMode"])}>
                <option value="rotaryWrap">旋转包裹 X/Z + 夹具轴</option>
                <option value="3axis">三轴平面浮雕 X/Y/Z</option>
                <option value="4axis">真实四轴 X/A/Z</option>
              </select>
            </label>
          )}
          {settings.camMode === "rotaryWrap" && (
            <>
              {!V3_TRIAL_FOCUSED_UI && (
                <label className="select-row">
                  <span>夹具接入轴</span>
                  <select
                    value={settings.rotaryOutputAxis}
                    onChange={(event) => {
                      const axis = event.target.value as ModelSettings["rotaryOutputAxis"];
                      setSettings((current) => normalizeSettings({
                        ...current,
                        rotaryOutputAxis: axis,
                        postProcessor: axis === "X" ? "wrapX" : axis === "Y" ? "wrapY" : "generic"
                      }));
                      setToolpath(null);
                      setIsSimulationMode(false);
                      setWorkbenchView("model");
                    }}
                  >
                    <option value="Y">Y轴代替旋转</option>
                    <option value="X">X轴代替旋转</option>
                    <option value="A">真实A轴</option>
                  </select>
                </label>
              )}
              <Control label="每圈距离" value={settings.rotaryWrapPerRevolutionMm} min={1} max={1000} step={1} suffix="mm/圈" onChange={(v) => updateSetting("rotaryWrapPerRevolutionMm", v)} />
            </>
          )}
          {!V3_TRIAL_FOCUSED_UI && <Control label="刀具直径" value={settings.toolDiameter} min={0.2} max={6} step={0.05} suffix="mm" onChange={(v) => updateSetting("toolDiameter", v)} />}
          {settings.camMode !== "3axis" && (
            <>
              <Control label="左端夹持" value={settings.leftHoldMm} min={0} max={8} step={0.1} suffix="mm" onChange={(v) => updateSetting("leftHoldMm", v)} />
              <Control label="右端夹持" value={settings.rightHoldMm} min={0} max={8} step={0.1} suffix="mm" onChange={(v) => updateSetting("rightHoldMm", v)} />
              <Control label="端部过渡" value={settings.endTransitionMm} min={0} max={6} step={0.1} suffix="mm" onChange={(v) => updateSetting("endTransitionMm", v)} />
            </>
          )}
          <Control label="X步距" value={settings.stepoverMm} min={0.03} max={0.8} step={0.01} suffix="mm" onChange={(v) => updateSetting("stepoverMm", v)} />
          {settings.camMode !== "3axis" && <Control label="A步距" value={settings.stepoverDeg} min={0.2} max={5} step={0.1} suffix="°" onChange={(v) => updateSetting("stepoverDeg", v)} />}
          <Control label="最大单层切深" value={settings.maxCutDepth} min={0.02} max={0.5} step={0.01} suffix="mm" onChange={(v) => updateSetting("maxCutDepth", v)} />
          {!V3_TRIAL_FOCUSED_UI && <Control label="粗加工余量" value={settings.stockAllowance} min={0} max={0.5} step={0.01} suffix="mm" onChange={(v) => updateSetting("stockAllowance", v)} />}
          <Control label="进给" value={settings.feedRate} min={30} max={600} step={10} suffix="mm/min" onChange={(v) => updateSetting("feedRate", v)} />
          <Control label="主轴" value={settings.spindleRpm} min={3000} max={24000} step={500} suffix="rpm" onChange={(v) => updateSetting("spindleRpm", v)} />
          {!V3_TRIAL_FOCUSED_UI && (
            <>
              <label className="select-row">
                <span>精修策略</span>
                <select value={settings.finishingStrategy} onChange={(event) => updateSetting("finishingStrategy", event.target.value as ModelSettings["finishingStrategy"])}>
                  <option value="x-scan">沿 X 扫描</option>
                  <option value="a-scan">{settings.camMode === "3axis" ? "沿 Y 扫描" : "沿 A 轴环扫"}</option>
                  <option value="cross">交叉精修</option>
                </select>
              </label>
              <label className="select-row">
                <span>后处理</span>
                <select value={settings.postProcessor} onChange={(event) => updateSetting("postProcessor", event.target.value as ModelSettings["postProcessor"])}>
                  <option value="generic">通用四轴</option>
                  <option value="weihong">维宏风格</option>
                  <option value="syntec">新代风格</option>
                  <option value="generic3">通用三轴</option>
                  <option value="wrapY">Y轴旋转包裹</option>
                  <option value="wrapX">X轴旋转包裹</option>
                </select>
              </label>
            </>
          )}
          {!V3_TRIAL_FOCUSED_UI && <button className="primary-action" onClick={handleGenerateToolpath} disabled={isToolpathGenerating}>
            <Hammer size={18} />
            {isToolpathGenerating ? "刀路生成中..." : "生成刀路"}
          </button>}
          {!V3_TRIAL_FOCUSED_UI && <button className="demo-action" type="button" onClick={() => toolpathImportRef.current?.click()} disabled={isToolpathGenerating}>
            <UploadCloud size={17} />
            导入NC/G-code预览
          </button>}
          <input
            ref={toolpathImportRef}
            className="hidden-file-input"
            type="file"
            accept=".nc,.tap,.gcode,.ngc,.cnc,.txt,.csv,text/plain,text/csv"
            onChange={handleImportToolpathFile}
          />
          {!V3_TRIAL_FOCUSED_UI && <button className="demo-action finish-action" onClick={handleGenerateFinishingToolpath} disabled={isToolpathGenerating}>
            <Hammer size={17} />
            生成精加工刀路
          </button>}
        </section>}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>导出前安全校验</h2>
            </div>
            <div className={`safety-verdict ${safetyGateStatus.level}`}>
              <strong>{safetyGateStatus.title}</strong>
              <span>{safetyGateStatus.detail}</span>
            </div>
            <div className="safety-list">
              {safetyIssues.map((issue, index) => (
                <div className={`safety-item ${issue.level}`} key={`${issue.title}-${index}`}>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                  {issue.command && <code>{issue.command}</code>}
                </div>
              ))}
            </div>
            <div className="report-actions">
              <button className="demo-action" type="button" onClick={() => handleDownloadSafetyReport("md")} disabled={!canDownloadSafetyReport}>
                下载安全报告 MD
              </button>
              <button className="demo-action" type="button" onClick={() => handleDownloadSafetyReport("json")} disabled={!canDownloadSafetyReport}>
                下载安全报告 JSON
              </button>
            </div>
            <div className={`export-gate ${safetyGateStatus.level}`}>
              <strong>{exportGateReady ? "正式加工文件已解锁" : "正式加工文件锁定"}</strong>
              <span>{exportGateReady ? "ZIP/NC/TAP/TXT 已允许下载；首次仍建议软材料或降进给试雕。" : safetyGateStatus.detail}</span>
            </div>
            <div className="export-gate-list">
              <label className={exportGate.safetyReportReviewed ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.safetyReportReviewed}
                  onChange={(event) => setExportGate((current) => ({ ...current, safetyReportReviewed: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已查看安全报告</span>
              </label>
              <label className={exportGate.airRunVerified ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.airRunVerified}
                  onChange={(event) => setExportGate((current) => ({ ...current, airRunVerified: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已下载/完成离料空跑</span>
              </label>
              <label className={exportGate.fixtureConfirmed ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.fixtureConfirmed}
                  onChange={(event) => setExportGate((current) => ({ ...current, fixtureConfirmed: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已确认夹持区和刀具装夹</span>
              </label>
            </div>
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <ClipboardCheck size={18} />
              <h2>机床验收记录</h2>
            </div>
            <p className="panel-note">按当前机床 Profile 记录空跑、软材料试雕和正式材料试雕。首次换机床或换后处理器时，应重新验收。</p>
            <div className={`machine-acceptance-verdict ${machineAcceptanceStatus.level}`}>
              <strong>{machineAcceptanceStatus.title}</strong>
              <span>{machineAcceptanceStatus.detail}</span>
            </div>
            <div className="machine-acceptance-list">
              {(["airRun", "softTrial", "formalTrial"] as const).map((step) => (
                <label className={selectedMachineAcceptance[step] ? "checked" : ""} key={step}>
                  <input
                    type="checkbox"
                    checked={selectedMachineAcceptance[step]}
                    onChange={(event) => updateMachineAcceptance(step, event.target.checked)}
                    disabled={!toolpath && step !== "airRun"}
                  />
                  <span>{formatMachineAcceptanceStep(step)}</span>
                  <small>{getMachineAcceptanceStepTime(selectedMachineAcceptance, step) ?? "未记录"}</small>
                </label>
              ))}
            </div>
            <label className="field-control machine-acceptance-notes">
              <span>验收备注</span>
              <textarea
                value={selectedMachineAcceptance.notes}
                onChange={(event) => updateMachineAcceptanceNotes(event.target.value)}
                placeholder="例如：A轴方向已确认；软材料树脂试雕无撞刀；正式橄榄核需降低进给 10%。"
              />
            </label>
            <button
              className="demo-action package-action"
              type="button"
              onClick={syncV3MachineAcceptance}
              disabled={!v3Job?.id || isV3MachineAcceptanceSyncing}
            >
              <ClipboardCheck size={17} />
              {isV3MachineAcceptanceSyncing ? "同步中..." : "同步到V3证据链"}
            </button>
            {!v3Job?.id && <small className="panel-hint">生成 V3 加工包后，可把当前机床验收同步为生产证据。</small>}
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <BadgeInfo size={18} />
              <h2>加工质量体检</h2>
            </div>
            <div className={`quality-score ${manufacturingQuality.verdict}`}>
              <strong>{manufacturingQuality.score.toFixed(1)}</strong>
              <span>{manufacturingQuality.summary}</span>
            </div>
            <div className="inspection-list">
              {manufacturingQuality.items.map((item) => (
                <div className={`inspection-item ${item.status}`} key={item.label}>
                  <div>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <p>{item.detail}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && envelopeQuality && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>包络诊断</h2>
            </div>
            <div className={`envelope-diagnosis ${envelopeQuality.diagnosis.level}`}>
              <strong>{envelopeQuality.diagnosis.title}</strong>
              <span>{envelopeQuality.diagnosis.detail}</span>
            </div>
            <div className="envelope-region-grid">
              {envelopeQuality.regions.map((region) => (
                <div className={`envelope-region ${region.status}`} key={region.label}>
                  <span>{region.label}</span>
                  <strong>{region.fitRate.toFixed(1)}%</strong>
                  <small>未贴合 {region.missCount}/{region.total}</small>
                </div>
              ))}
            </div>
            <div className="quality-notes">
              {envelopeQuality.diagnosis.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Layers3 size={18} />
              <h2>材料去除仿真</h2>
            </div>
            {materialRemoval ? (
              <>
                <div className={`simulation-verdict ${materialRemoval.verdict}`}>
                  <strong>{materialRemoval.score.toFixed(1)} / 100</strong>
                  <span>{materialRemoval.summary}</span>
                </div>
                <div className="simulation-metric-grid">
                  {materialRemoval.metrics.map((metric) => (
                    <div className={`simulation-metric ${metric.status}`} key={metric.label}>
                      <div>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </div>
                      <p>{metric.detail}</p>
                    </div>
                  ))}
                </div>
                <div className="quality-notes">
                  {materialRemoval.suggestions.slice(0, 3).map((suggestion) => (
                    <span key={suggestion}>{suggestion}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="panel-note">生成刀路后会按球刀、平刀、锥刀等刀具扫掠几何，估算刀痕、覆盖、过切、欠切和残料风险。</p>
            )}
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Calculator size={18} />
              <h2>工时与成本估算</h2>
            </div>
            {costEstimate ? (
              <>
                <div className={`estimate-confidence ${costEstimate.confidence}`}>
                  <strong>{formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh)}</strong>
                  <span>{costEstimate.confidence === "usable" ? "可用于试报价" : costEstimate.confidence === "review" ? "建议结合空跑复核" : "粗估，需实机校正"}</span>
                </div>
                <div className="estimate-grid">
                  <div>
                    <span>总占机</span>
                    <strong>{costEstimate.totalMinutes.toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>切削机时</span>
                    <strong>{costEstimate.machiningMinutes.toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>准备/检查</span>
                    <strong>{(costEstimate.setupMinutes + costEstimate.inspectionMinutes).toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>刀具损耗</span>
                    <strong>¥{costEstimate.toolWearCost.toFixed(0)}</strong>
                  </div>
                </div>
                <div className={`calibration-card ${costCalibration.confidence}`}>
                  <div>
                    <span>实机校正</span>
                    <strong>{costCalibration.sampleCount > 0 ? `${costCalibration.calibratedTotalMinutes.toFixed(1)} min` : "待反馈"}</strong>
                  </div>
                  <p>
                    {costCalibration.sampleCount > 0
                      ? `基于 ${costCalibration.sampleCount} 条同机床/同刀具反馈，耗时系数 ${costCalibration.averageRatio.toFixed(2)}x，平均误差 ${(costCalibration.averageErrorRate * 100).toFixed(1)}%。`
                      : "完成空跑或试雕后，在“反馈”阶段录入真实耗时，系统会自动校正后续估算。"}
                  </p>
                  {costCalibration.sampleCount > 0 && (
                    <small>校正成本 {formatCurrencyRange(costCalibration.calibratedCostLow, costCalibration.calibratedCostHigh)} / 可信度 {formatCalibrationConfidence(costCalibration.confidence)}</small>
                  )}
                </div>
                <div className="estimate-assumptions">
                  {costEstimate.assumptions.slice(0, 3).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="panel-note">生成刀路后会按机床小时费、准备时间、材料和刀具损耗估算总占机时间与成本区间。</p>
            )}
          </section>
        )}

        {activeStage === "cam" && (
          <section className="panel">
          <div className="panel-title">
            <Cloud size={18} />
            <h2>V3 Orchestrator 小闭环</h2>
          </div>
          <p className="panel-note">当前主线是三轴控制器 + Y轴旋转夹具：先跑 V3 小闭环，再下载安全试雕包做标定、空跑和低风险试雕。</p>
            {V3_TRIAL_FOCUSED_UI && v3UserNotice && (
              <div className={`v3-user-notice ${v3UserNotice.level}`}>
                <strong>{v3UserNotice.title}</strong>
                <span>{v3UserNotice.detail}</span>
              </div>
            )}
            {V3_TRIAL_FOCUSED_UI && (
              <div className="v3-focused-mainline">
                <div>
                  <strong>当前保留主线</strong>
                  <small>非必要的旧版直接 NC 下载、正式生产包和高级 Adapter 面板暂时收起；先把真实 3D 模型到安全试雕闭环跑稳。</small>
                </div>
                <div className="v3-focused-actions">
                  <button className="demo-action package-action" type="button" onClick={() => setActiveStage("model")}>
                    <Box size={17} />
                    导入/生成3D模型
                  </button>
              <button
                className="primary-action package-action"
                onClick={handleRunV3OrchestratorLoop}
                disabled={isV3JobRunning || !isModelReadyForCam}
                type="button"
                title={isModelReadyForCam ? "提交当前 GLB/STL 到后端 Orchestrator，生成旋转夹具空跑、候选试雕 NC、报告和清单" : "请先导入 GLB/STL 或等待原始模型上传到后端缓存"}
              >
                <Cloud size={17} />
                {isV3JobRunning ? "生成中..." : "生成试雕刀路与安全包"}
                  </button>
                  <button
                    className="primary-action package-action"
                    onClick={handleDownloadV3TrialPackage}
                    disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading}
                    type="button"
                    title="只包含标定、空跑、报告、清单，以及门禁允许的试雕候选文件"
                  >
                    <Download size={17} />
                    {isV3PackageDownloading ? "打包中..." : "下载安全试雕包"}
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadOperatorPackage}
                    disabled={!canDownloadOperatorPackage}
                    title="下载 V3 后端生成的操作员说明或下载核验清单"
                  >
                    <Download size={17} />
                    加工包说明
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadAirRun}
                    disabled={!canDownloadAirRun}
                    title="下载主轴关闭、Z 保持安全高度的离料空跑 NC"
                  >
                    <Download size={17} />
                    下载空跑 NC
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={() => handleDownloadSafetyReport("json")}
                    disabled={!canDownloadSafetyReport}
                    title="下载 V3 生产门禁或 NC 静态分析 JSON 报告"
                  >
                    <Download size={17} />
                    下载安全报告 JSON
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={() => handleDownloadSafetyReport("md")}
                    disabled={!canDownloadSafetyReport}
                    title="下载 V3 操作员说明或下载核验 Markdown"
                  >
                    <Download size={17} />
                    下载安全报告 MD
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handlePrepareV3CamoticsCliPackage}
                    disabled={!v3Job?.id || isV3CamoticsPackagePreparing}
                    title="生成给 Linux CAM/CAMotics 服务器使用的材料去除仿真输入包"
                  >
                    <Download size={17} />
                    {isV3CamoticsPackagePreparing ? "生成中..." : "生成仿真准备包"}
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadV3CamoticsLinuxPackage}
                    disabled={!v3Job?.id || !v3Job.result?.summary.camoticsCliPackage || isV3PackageDownloading}
                    title="下载到 Linux 服务器运行 CAMotics，回填真实材料去除证据"
                  >
                    <Download size={17} />
                    下载Linux仿真包
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadV3LinuxCamJobPackage}
                    disabled={!v3Job?.id || !v3Job.result?.summary.camoticsCliPackage || isV3PackageDownloading}
                    title="下载包含 OpenCAMLib 输入、CAMotics 准备文件和回填说明的 Linux CAM 整单执行包"
                  >
                    <Download size={17} />
                    下载Linux整单包
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadV3OpenCamLibCandidateInputs}
                    disabled={!v3Job?.id || isV3PackageDownloading}
                    title="下载当前 job 的 OpenCAMLib real-candidate 输入包，复制到 Linux Native CAM 服务包后运行真实候选链路"
                  >
                    <Download size={17} />
                    下载OCL输入包
                  </button>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadV3EvidenceReviewPackage}
                    disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading}
                    title="集中下载当前 job 的门禁、哈希、仿真、后处理和现场证据报告；不是上机包"
                  >
                    <Download size={17} />
                    下载证据审查包
                  </button>
                </div>
              </div>
            )}
            {V3_TRIAL_FOCUSED_UI && (
              <div className={`v3-trial-workflow ${v3TrialWorkflow.level}`}>
                <div className="v3-trial-workflow-head">
                  <div>
                    <strong>安全试雕向导</strong>
                    <small>{v3TrialWorkflow.doneCount}/{v3TrialWorkflow.total} 已完成 · 当前：{v3TrialWorkflow.activeStep.title}</small>
                  </div>
                  <span>{v3TrialWorkflow.level === "ok" ? "证据已齐" : v3TrialWorkflow.level === "warning" ? "继续试雕" : "先补前置"}</span>
                </div>
                <div className="v3-trial-steps">
                  {v3TrialWorkflow.steps.map((step) => (
                    <div className={step.status} key={step.id}>
                      <strong>{step.title}</strong>
                      <small>{step.detail}</small>
                    </div>
                  ))}
                </div>
                {v3DownloadChecklistSummary && (
                  <div className="v3-trial-file-strip">
                    {v3DownloadChecklistSummary.keyFiles.map((file) => (
                      <span className={file.verified ? file.allowedOnMachine ? "ok" : "review" : "locked"} key={`trial-${file.filename}`}>
                        {formatV3ShortcutFileLabel(file.filename)}
                        <strong>{file.verified ? "已记录哈希" : "缺少哈希"}</strong>
                      </span>
                    ))}
                  </div>
                )}
                {v3Job?.result?.summary.safeTrialExecutionPlan && (
                  <div className="v3-trial-plan-card">
                    <div>
                      <strong>安全试雕执行计划</strong>
                      <small>
                        {v3Job.result.summary.safeTrialExecutionPlan.stepCount} 步
                        {" · "}
                        {v3Job.result.summary.safeTrialExecutionPlan.activeGate}
                        {" · "}
                        空跑 {v3Job.result.summary.safeTrialExecutionPlan.allowAirRun ? "可用" : "锁定"}
                        {" · "}
                        试雕NC {v3Job.result.summary.safeTrialExecutionPlan.allowTrialNc ? "可用" : "未放行"}
                      </small>
                    </div>
                    {v3SafeTrialPlanFile?.url && (
                      <a href={v3SafeTrialPlanFile.url} download>
                        下载执行计划
                      </a>
                    )}
                    {v3ClosedLoopHandoffFile?.url && (
                      <a href={v3ClosedLoopHandoffFile.url} download>
                        下载闭环交接说明
                      </a>
                    )}
                  </div>
                )}
                <div className="v3-trial-action-panel">
                  {v3TrialWorkflow.activeStep.id === "model" && (
                    <button className="primary-action package-action" type="button" onClick={() => setActiveStage("model")}>
                      <Box size={17} />
                      去导入/生成3D模型
                    </button>
                  )}
                  {v3TrialWorkflow.activeStep.id === "orchestrator" && (
                    <button
                      className="primary-action package-action"
                      onClick={handleRunV3OrchestratorLoop}
                      disabled={isV3JobRunning || !isModelReadyForCam}
                      type="button"
                      title={isModelReadyForCam ? "生成三轴控制器 + Y轴旋转夹具专用试雕数据" : "请先导入 GLB/STL 或等待原始模型上传到后端缓存"}
                    >
                      <Cloud size={17} />
                      {isV3JobRunning ? "生成中..." : "生成试雕刀路与安全包"}
                    </button>
                  )}
                  {v3TrialWorkflow.activeStep.id === "download" && (
                    <button
                      className="primary-action package-action"
                      onClick={handleDownloadV3TrialPackage}
                      disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading}
                      type="button"
                      title={v3Job?.result?.summary.deliveryManifest ? "下载安全试雕包，正式生产 NC 仍受门禁控制" : "请先生成试雕刀路与安全包"}
                    >
                      <Download size={17} />
                      {isV3PackageDownloading ? "打包中..." : "下载安全试雕包"}
                    </button>
                  )}
                  {v3TrialWorkflow.activeStep.id === "acceptance" && (
                    <>
                      <button className="primary-action package-action" type="button" onClick={() => setActiveStage("feedback")}>
                        <ClipboardCheck size={17} />
                        记录试雕反馈
                      </button>
                      <button
                        className="demo-action package-action"
                        type="button"
                        onClick={syncV3MachineAcceptance}
                        disabled={!v3Job?.id || isV3MachineAcceptanceSyncing}
                      >
                        <ShieldCheck size={17} />
                        {isV3MachineAcceptanceSyncing ? "同步中..." : "同步机床验收"}
                      </button>
                    </>
                  )}
                  {v3TrialWorkflow.activeStep.id !== "model" && (
                    <button className="demo-action package-action" type="button" onClick={() => setActiveStage("process")}>
                      <SlidersHorizontal size={17} />
                      检查机床/刀具参数
                    </button>
                  )}
                  {v3Job?.result?.summary.deliveryManifest && v3TrialWorkflow.activeStep.id !== "download" && (
                    <button
                      className="demo-action package-action"
                      onClick={handleDownloadV3TrialPackage}
                      disabled={isV3PackageDownloading}
                      type="button"
                    >
                      <Download size={17} />
                      重新下载试雕包
                    </button>
                  )}
                </div>
                <small>{v3TrialWorkflow.summary}</small>
              </div>
            )}
            {!V3_TRIAL_FOCUSED_UI && <div className="v3-engine-grid">
              {v3Engines.map((engine) => (
                <div className={`v3-engine ${engine.available ? "ok" : ""} ${engine.adapterReady ? "ready" : ""}`} key={engine.id}>
                  <div>
                    <strong>{engine.name}</strong>
                    <span>{engine.available ? engine.command ?? "available" : "未安装"}</span>
                  </div>
                  <small>{engine.notes}</small>
                </div>
              ))}
            </div>}
            {!V3_TRIAL_FOCUSED_UI && v3Diagnostics && (
              <div className={`v3-diagnostics ${v3Diagnostics.level}`}>
                <div className="v3-history-heading">
                  <strong>环境自检：{v3Diagnostics.level}</strong>
                  <button type="button" onClick={refreshV3Diagnostics}>刷新</button>
                </div>
                <span>{v3Diagnostics.summary}</span>
                <small>队列 {v3Diagnostics.queue.queued} / 运行 {v3Diagnostics.queue.running} / 并发 {v3Diagnostics.queue.concurrency}</small>
                {v3Diagnostics.recommendedActions.slice(0, 2).map((action) => (
                  <small key={action}>{action}</small>
                ))}
              </div>
            )}
            <div className={`v3-diagnostics ${v3Readiness?.level === "production-ready" ? "ok" : v3Readiness?.level === "blocked" ? "critical" : "warning"}`}>
              <div className="v3-history-heading">
                <strong>V3 生产就绪总门禁</strong>
                <button type="button" onClick={refreshV3Readiness}>刷新</button>
              </div>
              {v3Readiness ? (
                <>
                  <span>
                    {v3Readiness.level}
                    {" · "}
                    生产NC {v3Readiness.gates.allowProductionNc ? "允许" : "未解锁"}
                    {" · "}
                    试雕 {v3Readiness.gates.allowTrialNc ? "可用" : "不可用"}
                    {" · "}
                    空跑 {v3Readiness.gates.allowAirRun ? "可用" : "不可用"}
                  </span>
                  <small>{v3Readiness.summary}</small>
                  {v3Readiness.goalAudit && (
                    <small className={v3Readiness.goalAudit.productionAllowed ? "v3-inline-ok" : v3Readiness.goalAudit.blockedLayerCount > 0 ? "v3-inline-critical" : "v3-inline-warning"}>
                      目标差距：{v3Readiness.goalAudit.status}
                      {" · "}
                      ready {v3Readiness.goalAudit.readyLayerCount}
                      {" · "}
                      partial {v3Readiness.goalAudit.partialLayerCount}
                      {" · "}
                      blocked {v3Readiness.goalAudit.blockedLayerCount}
                      {v3Readiness.goalAudit.worstLayer ? ` · 最弱：${v3Readiness.goalAudit.worstLayer.title}` : ""}
                      {v3Readiness.goalAudit.nextBestActions[0] ? ` · 下一步：${v3Readiness.goalAudit.nextBestActions[0]}` : ""}
                    </small>
                  )}
                  {!V3_TRIAL_FOCUSED_UI && <>
                  {v3Readiness.nativeCam && (
                    <>
                      <small>Native CAM {v3Readiness.nativeCam.readyCount}/{v3Readiness.nativeCam.requiredCount} · {v3Readiness.nativeCam.level}</small>
                      {v3Readiness.nativeCam.serverPackage?.files?.length ? (
                        <small>服务端准备包：{v3Readiness.nativeCam.serverPackage.files.length} 个文件</small>
                      ) : null}
                    </>
                  )}
                  {v3Readiness.camServerConfig && (
                    <>
                      <small className={v3Readiness.camServerConfig.status === "ready-to-attempt-external-cam" ? "v3-inline-ok" : v3Readiness.camServerConfig.status === "missing-native-dependencies" ? "v3-inline-critical" : "v3-inline-warning"}>
                        CAM服务器配置：{v3Readiness.camServerConfig.status}
                        {" · "}
                        {v3Readiness.camServerConfig.selectedEngineName}
                        {" · "}
                        缺失 {v3Readiness.camServerConfig.missingRequired.length}
                      </small>
                      {v3Readiness.camServerConfig.deploymentValidation && (
                        <div className="v3-deployment-validation">
                          <small>
                            CAM服务器验收：{v3Readiness.camServerConfig.deploymentValidation.requiredAdapters.join(" / ") || "未指定"}
                            {" · "}
                            阶段 {v3Readiness.camServerConfig.deploymentValidation.stages.length}
                          </small>
                          <div className="v3-adapter-list">
                            {v3Readiness.camServerConfig.deploymentValidation.stages.slice(0, 5).map((stage) => (
                              <span className={stage.blocksProduction ? "warning" : "ok"} key={stage.id} title={stage.command}>
                                {stage.title}
                              </span>
                            ))}
                          </div>
                          {v3Readiness.camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff[0] && (
                            <small className="v3-inline-warning">
                              生产必须关闭：{v3Readiness.camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff.slice(0, 3).join("、")}
                            </small>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {v3Readiness.adapterValidation && (
                    <small className={v3Readiness.adapterValidation.handoffClassificationAudit?.unsafeCount ? "v3-inline-critical" : v3Readiness.adapterValidation.handoffClassificationAudit?.productionCandidateCount ? "v3-inline-ok" : "v3-inline-warning"}>
                      Adapter 计划 {v3Readiness.adapterValidation.generatedPlans}
                      {" · "}
                      失败 {v3Readiness.adapterValidation.failed}
                      {" · "}
                      completed {v3Readiness.adapterValidation.completedAdapters}
                      {v3Readiness.adapterValidation.handoffClassificationAudit
                        ? ` · productionCandidate ${v3Readiness.adapterValidation.handoffClassificationAudit.productionCandidateCount} · unsafe ${v3Readiness.adapterValidation.handoffClassificationAudit.unsafeCount}`
                        : ""}
                    </small>
                  )}
                  <small className={v3Readiness.nativeCamRealOutputAcceptance ? v3Readiness.nativeCamRealOutputAcceptance.level === "ready" ? "v3-inline-ok" : v3Readiness.nativeCamRealOutputAcceptance.level === "critical" ? "v3-inline-critical" : "v3-inline-warning" : "v3-inline-warning"}>
                    真实CAM输出验收：{v3Readiness.nativeCamRealOutputAcceptance ? `${v3Readiness.nativeCamRealOutputAcceptance.level} · candidate ${v3Readiness.nativeCamRealOutputAcceptance.productionCandidateCount} · unsafe ${v3Readiness.nativeCamRealOutputAcceptance.unsafeCount} · missing ${v3Readiness.nativeCamRealOutputAcceptance.missingCount}` : "未运行"}
                    {v3Readiness.nativeCamRealOutputAcceptance ? ` · sourceBinding ${v3Readiness.nativeCamRealOutputAcceptance.sourceReportBindingStatus ?? "missing"}` : ""}
                    {v3Readiness.nativeCamRealOutputAcceptance ? ` · machineBoundary ${v3Readiness.nativeCamRealOutputAcceptance.targetMachineBoundaryStatus?.status ?? "missing"}` : ""}
                    {v3Readiness.nativeCamRealOutputAcceptance?.blockers[0] ? ` · ${v3Readiness.nativeCamRealOutputAcceptance.blockers[0]}` : ""}
                  </small>
                  {v3Readiness.nativeCamRealOutputAcceptance?.targetMachineBoundaryStatus && v3Readiness.nativeCamRealOutputAcceptance.targetMachineBoundaryStatus.status !== "matched" && (
                    <small className="v3-inline-critical">
                      机型边界：{v3Readiness.nativeCamRealOutputAcceptance.targetMachineBoundaryStatus.summary ?? "真实 CAM 输出未证明适配三轴控制器 + Y轴旋转夹具 / wrapY / 4mm 25度平底尖刀。"}
                    </small>
                  )}
                  <small className={v3Readiness.externalHandoff ? v3Readiness.externalHandoff.status === "completed" && v3Readiness.externalHandoff.simulationStatus === "completed" ? "v3-inline-ok" : "v3-inline-critical" : "v3-inline-warning"}>
                    Handoff：{v3Readiness.externalHandoff ? `${v3Readiness.externalHandoff.resultEngine ?? "-"} → ${v3Readiness.externalHandoff.simulationEngine ?? "-"}` : "未验证"}
                    {v3Readiness.externalHandoff?.syntheticSimulation ? " · synthetic仿真" : ""}
                    {v3Readiness.externalHandoff?.points ? ` · ${v3Readiness.externalHandoff.points}点` : ""}
                  </small>
                  <div className="v3-adapter-list">
                    {(["freecad", "blendercam", "opencamlib"] as const).map((engineId) => {
                      const handoff = v3Readiness.externalCamHandoffs?.byEngine?.[engineId];
                      const ready = handoff?.status === "completed" && handoff?.simulationStatus === "completed";
                      return (
                        <span className={ready ? "ok" : handoff ? "critical" : "warning"} key={engineId}>
                          {formatExternalCamEngineLabel(engineId)} · {formatExternalCamHandoff(handoff)}
                        </span>
                      );
                    })}
                  </div>
                  <small className={v3Readiness.neutralImport ? v3Readiness.neutralImport.postprocessEligible ? v3Readiness.neutralImport.sourceBindingStatus === "bound" ? "v3-inline-ok" : "v3-inline-warning" : "v3-inline-critical" : "v3-inline-warning"}>
                    Neutral导入：{v3Readiness.neutralImport ? `${v3Readiness.neutralImport.status ?? "-"} · ${v3Readiness.neutralImport.imported ? "真实导入" : "未导入"}` : "未验证"}
                    {v3Readiness.neutralImport?.pointCount ? ` · ${v3Readiness.neutralImport.pointCount}点` : ""}
                    {v3Readiness.neutralImport ? ` · sourceBinding ${v3Readiness.neutralImport.sourceBindingStatus ?? "missing"}` : ""}
                  </small>
                  <small className={v3Readiness.postprocessHandoffReadiness ? v3Readiness.postprocessHandoffReadiness.status === "ready" ? "v3-inline-ok" : v3Readiness.postprocessHandoffReadiness.status === "blocked" ? "v3-inline-critical" : "v3-inline-warning" : "v3-inline-warning"}>
                    后处理交接：{v3Readiness.postprocessHandoffReadiness ? `${v3Readiness.postprocessHandoffReadiness.status} · ${v3Readiness.postprocessHandoffReadiness.required ? "生产必需" : "待验证"} · ${v3Readiness.postprocessHandoffReadiness.source}` : "未验证"}
                    {v3Readiness.postprocessHandoffReadiness?.pointCount ? ` · ${v3Readiness.postprocessHandoffReadiness.pointCount}点` : ""}
                    {v3Readiness.postprocessHandoffReadiness?.sourceBindingStatus ? ` · sourceBinding ${v3Readiness.postprocessHandoffReadiness.sourceBindingStatus}` : ""}
                    {v3Readiness.postprocessHandoffReadiness?.nextActions[0] ? ` · ${v3Readiness.postprocessHandoffReadiness.nextActions[0]}` : ""}
                  </small>
                  <small className={v3Readiness.camoticsImport ? v3Readiness.camoticsImport.productionEvidenceEligible && v3Readiness.camoticsImport.inputIdentityStatus === "matched" && v3Readiness.camoticsImport.machineContextStatus === "matched" ? "v3-inline-ok" : "v3-inline-critical" : "v3-inline-warning"}>
                    CAMotics导入：{v3Readiness.camoticsImport ? `${v3Readiness.camoticsImport.status ?? "-"} · ${v3Readiness.camoticsImport.synthetic ? "synthetic" : "真实结果"}` : "未验证"}
                    {v3Readiness.camoticsImport?.riskLevel ? ` · ${v3Readiness.camoticsImport.riskLevel}` : ""}
                    {v3Readiness.camoticsImport ? ` · input ${v3Readiness.camoticsImport.inputIdentityStatus ?? "missing"} · cli ${v3Readiness.camoticsImport.cliRunPackageBindingStatus ?? "not-required"} · motion ${v3Readiness.camoticsImport.motionConsistencyStatus ?? "missing"} · machine ${v3Readiness.camoticsImport.machineContextStatus ?? "missing"}` : ""}
                  </small>
                  <small className={v3Readiness.readinessCamoticsEvidence ? v3Readiness.readinessCamoticsEvidence.productionEvidenceEligible && v3Readiness.readinessCamoticsEvidence.inputIdentityStatus === "matched" && v3Readiness.readinessCamoticsEvidence.machineContextStatus === "matched" ? "v3-inline-ok" : "v3-inline-critical" : "v3-inline-warning"}>
                    材料去除证据：{v3Readiness.readinessCamoticsEvidence ? `${v3Readiness.readinessCamoticsEvidence.status ?? "-"} · ${formatReadinessCamoticsSource(v3Readiness.readinessCamoticsEvidence.source)}` : "未验证"}
                    {v3Readiness.readinessCamoticsEvidence ? ` · eligible ${v3Readiness.readinessCamoticsEvidence.productionEvidenceEligible ? "yes" : "no"} · input ${v3Readiness.readinessCamoticsEvidence.inputIdentityStatus} · cli ${v3Readiness.readinessCamoticsEvidence.cliRunPackageBindingStatus} · motion ${v3Readiness.readinessCamoticsEvidence.motionConsistencyStatus} · machine ${v3Readiness.readinessCamoticsEvidence.machineContextStatus}` : ""}
                    {v3Readiness.readinessCamoticsEvidence?.jobId ? ` · job ${v3Readiness.readinessCamoticsEvidence.jobId.slice(0, 8)}` : ""}
                  </small>
                  </>}
                  <small className={v3Readiness.latestTrialFeedback ? v3Readiness.latestTrialFeedback.latestOutcome === "success" ? "v3-inline-ok" : v3Readiness.latestTrialFeedback.latestOutcome === "failed" ? "v3-inline-critical" : "v3-inline-warning" : "v3-inline-warning"}>
                    最新试雕反馈：{v3Readiness.latestTrialFeedback ? `${v3Readiness.latestTrialFeedback.recordCount} 条 · ${v3Readiness.latestTrialFeedback.latestOutcome ?? "-"}` : "未回填"}
                    {v3Readiness.latestTrialFeedback?.latestIssues?.length ? ` · ${v3Readiness.latestTrialFeedback.latestIssues.join("、")}` : ""}
                    {v3Readiness.latestTrialFeedback ? ` · 包绑定 ${v3Readiness.latestTrialFeedback.latestDownloadIntegrityBound ?? "missing"}` : ""}
                  </small>
                  <small className={v3Readiness.latestMachineAcceptance ? v3Readiness.latestMachineAcceptance.latestAllRequiredPassed ? "v3-inline-ok" : v3Readiness.latestMachineAcceptance.latestOutcome === "failed" ? "v3-inline-critical" : "v3-inline-warning" : "v3-inline-warning"}>
                    最新机床验收：{v3Readiness.latestMachineAcceptance ? `${v3Readiness.latestMachineAcceptance.recordCount} 条 · ${v3Readiness.latestMachineAcceptance.latestOutcome ?? "-"}` : "未回填"}
                    {v3Readiness.latestMachineAcceptance ? ` · 必需项 ${v3Readiness.latestMachineAcceptance.latestAllRequiredPassed ? "已通过" : "待复核"}` : ""}
                  </small>
                  <small className={v3Readiness.runbookResult ? v3Readiness.runbookResult.ok ? "v3-inline-ok" : "v3-inline-critical" : "v3-inline-warning"}>
                    验收脚本：{v3Readiness.runbookResult ? v3Readiness.runbookResult.ok ? "通过" : `失败 ${v3Readiness.runbookResult.failedCount} 项` : "未运行"}
                    {v3Readiness.runbookResult ? ` · 阻断 ${v3Readiness.runbookResult.blockingFailedCount ?? "-"} · 身份 ${v3Readiness.runbookResult.identityValid ? "已绑定" : "待复核"} · safe ${v3Readiness.runbookResult.productionSafe ? "yes" : "no"}` : ""}
                    {v3Readiness.runbookResult?.failedSteps[0] ? ` · ${v3Readiness.runbookResult.failedSteps[0].title}` : ""}
                  </small>
                  {v3Readiness.runbookResult?.linuxEvidence && (
                    <>
                      <small className={v3Readiness.runbookResult.linuxEvidence.status === "ready-for-review" ? "v3-inline-ok" : "v3-inline-critical"}>
                        Linux证据：{formatRunbookLinuxEvidenceStatus(v3Readiness.runbookResult.linuxEvidence.status)}
                        {` · 必需 ${v3Readiness.runbookResult.linuxEvidence.requiredFoundCount ?? 0}/2`}
                        {v3Readiness.runbookResult.linuxEvidence.missingRequired?.length
                          ? ` · 缺 ${v3Readiness.runbookResult.linuxEvidence.missingRequired.join(", ")}`
                          : ""}
                      </small>
                      {v3Readiness.runbookResult.linuxEvidence.evidenceChain?.openCamLib && (
                        <small className={v3Readiness.runbookResult.linuxEvidence.evidenceChain.openCamLib.realCandidateReady ? "v3-inline-ok" : "v3-inline-warning"}>
                          Linux OpenCAMLib：{formatLinuxOpenCamLibEvidence(v3Readiness.runbookResult.linuxEvidence.evidenceChain.openCamLib)}
                        </small>
                      )}
                      {v3Readiness.runbookResult.linuxEvidence.evidenceChain?.camotics && (
                        <small className={v3Readiness.runbookResult.linuxEvidence.evidenceChain.camotics.upstreamEvidence?.status === "matched" ? "v3-inline-ok" : "v3-inline-warning"}>
                          Linux CAMotics绑定：{formatLinuxCamoticsUpstreamEvidence(v3Readiness.runbookResult.linuxEvidence.evidenceChain.camotics)}
                        </small>
                      )}
                    </>
                  )}
                  {!V3_TRIAL_FOCUSED_UI && v3Readiness.acceptancePlan && (
                    <>
                      <small>
                        部署验收 {v3Readiness.acceptancePlan.completed}/{v3Readiness.acceptancePlan.total}
                        {v3Readiness.acceptancePlan.nextStep ? ` · 下一步：${v3Readiness.acceptancePlan.nextStep.title}` : " · 已完成"}
                      </small>
                      <div className="v3-adapter-list">
                        {v3Readiness.acceptancePlan.steps.slice(0, 5).map((step) => (
                          <span className={step.status === "done" ? "ok" : step.status === "blocked" ? "critical" : "warning"} key={step.id}>
                            {step.order}. {step.title} · {step.status}
                          </span>
                        ))}
                      </div>
                      {v3CamoticsPackageAcceptanceStep && (
                        <small className={v3CamoticsPackageAcceptanceStep.status === "done" ? "v3-inline-ok" : "v3-inline-warning"}>
                          CAMotics准备包：
                          {v3CamoticsPackageAcceptanceStep.status}
                          {" · "}
                          {v3CamoticsPackageAcceptanceStep.detail}
                        </small>
                      )}
                    </>
                  )}
                  {v3Readiness.gates.warnings[0] && (
                    <small>提示：{v3Readiness.gates.warnings[0]}</small>
                  )}
                  <div className="v3-artifact-list compact">
                    {v3Readiness.apiArtifacts?.json && (
                      <a href={v3Readiness.apiArtifacts.json} download>
                        下载总门禁JSON
                      </a>
                    )}
                    {v3Readiness.apiArtifacts?.markdown && (
                      <a href={v3Readiness.apiArtifacts.markdown} download>
                        下载总门禁报告
                      </a>
                    )}
                    {v3Readiness.apiArtifacts?.runbook && (
                      <a href={v3Readiness.apiArtifacts.runbook} download>
                        下载验收脚本
                      </a>
                    )}
                    {v3Readiness.apiArtifacts?.linuxEvidence && (
                      <a href={v3Readiness.apiArtifacts.linuxEvidence} download>
                        下载Linux证据JSON
                      </a>
                    )}
                    {v3Readiness.apiArtifacts?.camServerConfig && (
                      <a href={v3Readiness.apiArtifacts.camServerConfig} download>
                        下载CAM服务器配置
                      </a>
                    )}
                  </div>
                  <div className="v3-server-package">
                    <strong>验收脚本结果回填</strong>
                    <small>在 Linux CAM/部署服务器运行 v3-acceptance-runbook.sh 后，上传 v3-acceptance-runbook-result.json 或结果 ZIP；它会进入总门禁证据链，但不会单独解锁生产 NC。</small>
                    <label className="v3-file-picker">
                      <UploadCloud size={16} />
                      <span>{v3RunbookResultZipFile ? v3RunbookResultZipFile.name : "选择结果ZIP"}</span>
                      <input
                        accept=".zip,application/zip"
                        type="file"
                        onChange={(event) => setV3RunbookResultZipFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <label className="v3-file-picker">
                      <UploadCloud size={16} />
                      <span>{v3RunbookResultFile ? v3RunbookResultFile.name : "选择结果JSON"}</span>
                      <input
                        accept="application/json,.json"
                        type="file"
                        onChange={(event) => setV3RunbookResultFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <button
                      className="demo-action package-action"
                      disabled={(!v3RunbookResultFile && !v3RunbookResultZipFile) || isV3RunbookResultImporting}
                      onClick={handleImportV3RunbookResult}
                      type="button"
                    >
                      <ClipboardCheck size={17} />
                      {isV3RunbookResultImporting ? "导入中..." : "导入验收脚本结果"}
                    </button>
                  </div>
                </>
              ) : (
                <small>{V3_TRIAL_FOCUSED_UI ? "还没有 V3 总门禁报告；先完成安全试雕小闭环，再生成总门禁复核。" : "还没有 V3 总门禁报告；建议在 Native CAM、Adapter 验证和 V3 小闭环后生成。"}</small>
              )}
              {!V3_TRIAL_FOCUSED_UI && (
                <button className="demo-action package-action" onClick={handleRunV3Readiness} disabled={isV3ReadinessChecking} type="button">
                  <ClipboardCheck size={17} />
                  {isV3ReadinessChecking ? "生成中..." : "生成V3总门禁"}
                </button>
              )}
            </div>
            <div className={`v3-diagnostics ${v3NativeCamReadiness?.summary.level === "ready" ? "ok" : v3NativeCamReadiness ? "warning" : "critical"}`}>
              <div className="v3-history-heading">
                <strong>{V3_TRIAL_FOCUSED_UI ? "Linux CAM 服务闭环" : "Native CAM 环境验收"}</strong>
                <button type="button" onClick={refreshV3NativeCamReadiness}>刷新</button>
              </div>
              {v3NativeCamReadiness ? (
                <>
                  <span>
                    {v3NativeCamReadiness.summary.readyCount}/{v3NativeCamReadiness.summary.requiredCount}
                    {" · "}
                    {v3NativeCamReadiness.summary.level}
                    {v3NativeCamReadiness.host?.platform ? ` · ${v3NativeCamReadiness.host.platform}/${v3NativeCamReadiness.host.arch ?? "unknown"}` : ""}
                  </span>
                  <small>
                    {V3_TRIAL_FOCUSED_UI
                      ? "下载服务端 ZIP 到 Linux CAM 服务器，用真实外部 CAM/CAMotics 跑完后再回填结果；这一步只补证据链，不解锁正式生产 NC。"
                      : v3NativeCamReadiness.summary.text}
                  </small>
                  <div className="v3-adapter-list">
                    {v3NativeCamReadiness.checks.map((check) => (
                      <span className={check.ready ? "ok" : "warning"} key={check.id}>
                        {check.name} · {check.level}
                      </span>
                    ))}
                  </div>
                  {!V3_TRIAL_FOCUSED_UI && v3NativeCamReadiness.summary.capabilityMatrix && v3NativeCamReadiness.summary.capabilityMatrix.length > 0 && (
                    <div className="v3-capability-matrix">
                      {v3NativeCamReadiness.summary.capabilityMatrix.map((item) => (
                        <article className={`v3-capability-card ${item.ready ? "ready" : "missing"}`} key={item.id}>
                          <div>
                            <strong>{item.name}</strong>
                            <span>{item.category} · {item.level}</span>
                          </div>
                          <p>{item.integrationRole}</p>
                          <small>工艺：{item.supportedWorkflows.slice(0, 3).join(" / ")}</small>
                          <small>输出：{item.outputFormats.join(" / ")}</small>
                          <small>生产门禁：{item.productionGate}</small>
                        </article>
                      ))}
                    </div>
                  )}
                  {!V3_TRIAL_FOCUSED_UI && v3NativeCamReadiness.summary.executionPlan && (
                    <div className="v3-server-package">
                      <strong>开源 CAM 接入执行计划</strong>
                      <small>
                        {v3NativeCamReadiness.summary.executionPlan.readyStages}/{v3NativeCamReadiness.summary.executionPlan.totalStages}
                        {" · "}
                        {v3NativeCamReadiness.summary.executionPlan.summary}
                      </small>
                      <div className="v3-execution-plan">
                        {v3NativeCamReadiness.summary.executionPlan.stages.map((stage) => (
                          <article className={stage.engineReady ? "ready" : "missing"} key={stage.id}>
                            <div>
                              <strong>{stage.order}. {stage.title}</strong>
                              <span>{stage.priority} · {stage.status}</span>
                            </div>
                            <small>输入：{stage.input}</small>
                            <small>输出：{stage.output}</small>
                            <small>验收：{stage.acceptance}</small>
                          </article>
                        ))}
                      </div>
                      {v3NativeCamReadiness.summary.executionPlan.productionLocks[0] && (
                        <small>生产锁：{v3NativeCamReadiness.summary.executionPlan.productionLocks[0]}</small>
                      )}
                    </div>
                  )}
                  {!V3_TRIAL_FOCUSED_UI && v3NativeCamReadiness.checks.some((check) => check.capabilities?.notEnoughFor?.length) && (
                    <div className="v3-capability-boundary">
                      {v3NativeCamReadiness.checks
                        .filter((check) => check.capabilities?.notEnoughFor?.length)
                        .slice(0, 4)
                        .map((check) => (
                          <small key={check.id}>
                            {check.name} 不能替代：{check.capabilities?.notEnoughFor?.slice(0, 2).join("、")}
                          </small>
                        ))}
                    </div>
                  )}
                  {v3NativeCamReadiness.summary.blockers[0] && (
                    <small>阻断项：{v3NativeCamReadiness.summary.blockers[0]}</small>
                  )}
                  <div className="v3-artifact-list compact">
                    {v3NativeCamReadiness.apiArtifacts?.json && (
                      <a href={v3NativeCamReadiness.apiArtifacts.json} download>
                        下载验收JSON
                      </a>
                    )}
                    {v3NativeCamReadiness.apiArtifacts?.markdown && (
                      <a href={v3NativeCamReadiness.apiArtifacts.markdown} download>
                        下载验收报告
                      </a>
                    )}
                  </div>
                  {(v3NativeCamReadiness.packageArtifacts?.files?.length ?? 0) > 0 && (
                    <div className="v3-server-package">
                      <strong>Linux服务端准备包</strong>
                      <small>{V3_TRIAL_FOCUSED_UI ? "优先下载 ZIP 到 Linux 服务器执行；生成的真实输出 ZIP 再回填到这里，作为安全试雕证据。" : "用于在 CAM 服务器安装/探测 FreeCAD、OpenCAMLib、CAMotics，并保留生产边界。"}</small>
                      <div className="v3-artifact-list compact">
                        {v3NativeCamReadiness.apiArtifacts?.packageZip && (
                          <a href={v3NativeCamReadiness.apiArtifacts.packageZip} download>
                            下载服务端ZIP
                          </a>
                        )}
                        {v3NativeCamReadiness.apiArtifacts?.bootstrap && (
                          <a href={v3NativeCamReadiness.apiArtifacts.bootstrap} download>
                            下载安装脚本
                          </a>
                        )}
                        {v3NativeCamReadiness.apiArtifacts?.envTemplate && (
                          <a href={v3NativeCamReadiness.apiArtifacts.envTemplate} download>
                            下载环境模板
                          </a>
                        )}
                        {v3NativeCamReadiness.apiArtifacts?.checklist && (
                          <a href={v3NativeCamReadiness.apiArtifacts.checklist} download>
                            下载验收清单
                          </a>
                        )}
                        {v3NativeCamReadiness.apiArtifacts?.realOutputCheck && (
                          <a href={v3NativeCamReadiness.apiArtifacts.realOutputCheck} download>
                            下载真实输出验收
                          </a>
                        )}
                        {v3NativeCamReadiness.apiArtifacts?.packageManifest && (
                          <a href={v3NativeCamReadiness.apiArtifacts.packageManifest} download>
                            下载包清单
                          </a>
                        )}
                      </div>
                      {v3NativeCamReadiness.packageArtifacts.commands[0] && (
                        <small>服务器首步：{v3NativeCamReadiness.packageArtifacts.commands[0]}</small>
                      )}
                    </div>
                  )}
                  <div className="v3-server-package">
                    <strong>真实输出验收回填</strong>
                    <small>Linux CAM 服务器执行 native-cam-real-output-check.sh 后，可直接选择结果 ZIP，或单独选择 native-cam-real-output-acceptance.json 回填到总门禁。</small>
                    <label className="v3-file-picker">
                      <UploadCloud size={16} />
                      <span>{v3NativeCamAcceptanceZipFile ? v3NativeCamAcceptanceZipFile.name : "选择验收ZIP"}</span>
                      <input
                        accept=".zip,application/zip"
                        type="file"
                        onChange={(event) => setV3NativeCamAcceptanceZipFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <label className="v3-file-picker">
                      <UploadCloud size={16} />
                      <span>{v3NativeCamAcceptanceFile ? v3NativeCamAcceptanceFile.name : "选择验收JSON"}</span>
                      <input
                        accept="application/json,.json"
                        type="file"
                        onChange={(event) => setV3NativeCamAcceptanceFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <button
                      className="demo-action package-action"
                      disabled={(!v3NativeCamAcceptanceFile && !v3NativeCamAcceptanceZipFile) || isV3NativeCamAcceptanceImporting}
                      onClick={handleImportV3NativeCamRealOutputAcceptance}
                      type="button"
                    >
                      <ClipboardCheck size={17} />
                      {isV3NativeCamAcceptanceImporting ? "导入中..." : "导入真实输出验收"}
                    </button>
                  </div>
                </>
              ) : (
                <small>{V3_TRIAL_FOCUSED_UI ? "还没有 Linux CAM 服务包；先点击下方“生成服务包”，下载 ZIP 到 Linux CAM 服务器继续闭环验证。" : "还没有 Native CAM 环境验收记录；Linux CAM 服务器部署后建议先跑此检查。"}</small>
              )}
              <div className="v3-action-row">
                <button className="demo-action package-action" onClick={() => handleRunV3NativeCamReadiness(false)} disabled={isV3NativeCamChecking} type="button">
                  <HardDrive size={17} />
                  {isV3NativeCamChecking ? "生成中..." : V3_TRIAL_FOCUSED_UI ? "生成服务包" : "验收Native CAM"}
                </button>
                {!V3_TRIAL_FOCUSED_UI && (
                  <button className="demo-action package-action" onClick={() => handleRunV3NativeCamReadiness(true)} disabled={isV3NativeCamChecking} type="button">
                    <ShieldCheck size={17} />
                    严格验收
                  </button>
                )}
              </div>
            </div>
            {!V3_TRIAL_FOCUSED_UI && <div className={`v3-diagnostics ${v3AdapterValidation?.overall.failed ? "warning" : "ok"}`}>
              <div className="v3-history-heading">
                <strong>外部 Adapter 验证</strong>
                <button type="button" onClick={refreshV3AdapterValidation}>刷新</button>
              </div>
              {v3AdapterValidation ? (
                <>
                  <span>
                    {v3AdapterValidation.useNativeCommands ? "Native 外部引擎" : "安全模板"}
                    {" · "}
                    计划 {v3AdapterValidation.overall.generatedPlans}/{v3AdapterValidation.overall.adapterCount}
                    {" · "}
                    完成 {v3AdapterValidation.overall.completedAdapters}
                    {" · "}
                    失败 {v3AdapterValidation.overall.failed}
                  </span>
                  <small>
                    {v3AdapterValidation.overall.readyForProduction
                      ? "Adapter 验证已达到生产门禁要求"
                      : v3AdapterValidation.overall.note ?? "当前仍为 Adapter 接入验证，正式上机前还需要真实 CAM 与仿真通过"}
                  </small>
                  {v3AdapterValidation.nativeReadiness && (
                    <small>
                      Native预检：{v3AdapterValidation.nativeReadiness.readyCount}/{v3AdapterValidation.nativeReadiness.requiredCount}
                      {" · "}
                      {v3AdapterValidation.nativeReadiness.level}
                      {" · "}
                      {v3AdapterValidation.nativeReadiness.summary}
                    </small>
                  )}
                  {v3AdapterValidation.productionGuardrails && (
                    <small className={v3AdapterValidation.productionGuardrails.readyForProduction ? "v3-inline-ok" : "v3-inline-warning"}>
                      生产保护：{v3AdapterValidation.productionGuardrails.requiredCount} 项
                      {" · "}
                      {v3AdapterValidation.productionGuardrails.summary}
                    </small>
                  )}
                  {v3AdapterValidation.handoffClassificationAudit && (
                    <>
                      <small className={v3AdapterValidation.handoffClassificationAudit.productionCandidateCount > 0 && v3AdapterValidation.handoffClassificationAudit.unsafeCount === 0 ? "v3-inline-ok" : v3AdapterValidation.handoffClassificationAudit.unsafeCount > 0 ? "v3-inline-critical" : "v3-inline-warning"}>
                        Handoff分类：生产候选 {v3AdapterValidation.handoffClassificationAudit.productionCandidateCount}
                        {" · "}
                        unsafe {v3AdapterValidation.handoffClassificationAudit.unsafeCount}
                        {" · "}
                        contact绑定 {v3AdapterValidation.handoffClassificationAudit.contactReportBindingCounts?.bound ?? 0}
                        {" · "}
                        未绑定候选 {v3AdapterValidation.handoffClassificationAudit.unboundProductionCandidateCount ?? 0}
                        {" · "}
                        未生成 {v3AdapterValidation.handoffClassificationAudit.notGeneratedCount}
                        {" · "}
                        缺失 {v3AdapterValidation.handoffClassificationAudit.missingCount}
                      </small>
                      <div className="v3-handoff-audit-list">
                        {v3AdapterValidation.handoffClassificationAudit.adapters.map((adapter) => (
                          <span className={adapter.productionCandidate ? "ok" : adapter.unsafe ? "critical" : "warning"} key={adapter.id} title={adapter.outputKind ?? ""}>
                            {adapter.id} · {formatHandoffClassification(adapter.classification)}
                            {adapter.contactReport ? ` · contact ${adapter.contactReport.status} · binding ${adapter.contactReport.inputBindingStatus}` : ""}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="v3-adapter-list">
                    {v3AdapterValidation.adapters.map((adapter) => (
                      <span className={adapter.productionCandidate ? "ok" : adapter.handoffClassification === "missing" || adapter.handoffClassification === "not-generated" ? "warning" : adapter.report?.status === "completed" || adapter.plan.generated ? "ok" : "warning"} key={adapter.id}>
                        {adapter.name} · {adapter.report?.status ?? adapter.run?.status ?? adapter.run?.exitCode ?? "待验证"}
                        {adapter.handoffClassification ? ` · ${formatHandoffClassification(adapter.handoffClassification)}` : ""}
                        {adapter.contactReport ? ` · contact ${adapter.contactReport.status} · binding ${adapter.contactReport.inputBindingStatus}` : ""}
                      </span>
                    ))}
                  </div>
                  <div className="v3-artifact-list compact">
                    {v3AdapterValidation.apiArtifacts?.json && (
                      <a href={v3AdapterValidation.apiArtifacts.json} download>
                        下载验证JSON
                      </a>
                    )}
                    {v3AdapterValidation.apiArtifacts?.markdown && (
                      <a href={v3AdapterValidation.apiArtifacts.markdown} download>
                        下载验证报告
                      </a>
                    )}
                  </div>
                </>
              ) : (
                <small>还没有 Adapter 验证记录；可先跑安全模板验证，再按需跑 Native 外部引擎验证。</small>
              )}
              {!V3_TRIAL_FOCUSED_UI && (
                <div className="v3-action-row">
                  <button className="demo-action package-action" onClick={() => handleRunV3AdapterValidation(false)} disabled={isV3AdapterValidating} type="button">
                    <ClipboardCheck size={17} />
                    {isV3AdapterValidating ? "验证中..." : "验证外部Adapter"}
                  </button>
                  <button className="demo-action package-action" onClick={() => handleRunV3AdapterValidation(true)} disabled={isV3AdapterValidating} type="button">
                    <HardDrive size={17} />
                    Native验证
                  </button>
                </div>
              )}
            </div>}
            <div className="v3-status-card">
              <strong>{v3Job ? `任务 ${v3Job.status}` : "等待执行"}</strong>
              <span>{v3Status}</span>
              {v3Job && (
                <div className="v3-progress" aria-label={`V3进度${Math.round(v3Job.progress ?? 0)}%`}>
                  <i style={{ width: `${Math.max(0, Math.min(100, v3Job.progress ?? 0))}%` }} />
                  <small>阶段 {v3Job.currentStage ?? "queued"} · {Math.round(v3Job.progress ?? 0)}%</small>
                </div>
              )}
              {v3Job?.pipeline && v3Job.pipeline.length > 0 && (
                <div className="v3-pipeline">
                  {v3Job.pipeline.map((stage) => (
                    <div className={`v3-pipeline-stage ${stage.status}`} key={stage.id}>
                      <strong>{stage.label}</strong>
                      <span>{stage.status}</span>
                      <small>{stage.message}</small>
                    </div>
                  ))}
                </div>
              )}
              {v3EvidenceLoopSummary && (
                <div className={`v3-evidence-loop ${v3EvidenceLoopSummary.level}`}>
                  <div className="v3-evidence-loop-head">
                    <div>
                      <strong>{v3EvidenceLoopSummary.title}</strong>
                      <small>{v3EvidenceLoopSummary.detail}</small>
                    </div>
                    <span>{v3EvidenceLoopSummary.level === "ok" ? "可复核" : v3EvidenceLoopSummary.level === "warning" ? "待补证" : "禁止生产"}</span>
                  </div>
                  <div className="v3-evidence-grid">
                    {v3EvidenceLoopSummary.items.map((item) => (
                      <div className={item.level} key={item.id}>
                        <span>{item.title}</span>
                        <strong>{item.value}</strong>
                        <small>{item.detail}</small>
                      </div>
                    ))}
                  </div>
                  <div className="v3-next-actions">
                    {v3EvidenceLoopSummary.nextActions.slice(0, 3).map((action) => (
                      <small key={action}>{action}</small>
                    ))}
                  </div>
                  <button
                    className="demo-action package-action"
                    type="button"
                    onClick={handleDownloadV3EvidenceReviewPackage}
                    disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading}
                    title="下载当前 job 的证据链报告和缺失项清单；不是上机加工包"
                  >
                    <Download size={17} />
                    下载证据审查包
                  </button>
                  <div className="v3-camotics-import">
                    <div>
                      <strong>CAMotics 真实仿真闭环</strong>
                      <small>先生成 Linux 准备包，在 CAM 服务器执行材料去除仿真，再回填 camotics-result.json、截图或材料去除 STL。</small>
                    </div>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handlePrepareV3CamoticsCliPackage}
                      disabled={!v3Job?.id || isV3CamoticsPackagePreparing}
                    >
                      <Download size={17} />
                      {isV3CamoticsPackagePreparing ? "生成中..." : "生成仿真准备包"}
                    </button>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleDownloadV3CamoticsLinuxPackage}
                      disabled={!v3Job?.id || !v3Job.result?.summary.camoticsCliPackage || isV3PackageDownloading}
                    >
                      <Download size={17} />
                      {isV3PackageDownloading ? "打包中..." : "下载Linux仿真包"}
                    </button>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleDownloadV3LinuxCamJobPackage}
                      disabled={!v3Job?.id || !v3Job.result?.summary.camoticsCliPackage || isV3PackageDownloading}
                      title="整单下载 OpenCAMLib 输入、CAMotics 准备文件和证据回填说明"
                    >
                      <Download size={17} />
                      下载Linux整单包
                    </button>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleDownloadV3OpenCamLibCandidateInputs}
                      disabled={!v3Job?.id || isV3PackageDownloading}
                      title="复制到 Linux Native CAM 服务包目录，运行 opencamlib-real-candidate-run.mjs"
                    >
                      <Download size={17} />
                      下载OCL输入包
                    </button>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleRunV3CamoticsExecutionPreflight}
                      disabled={!v3Job?.id || isV3CamoticsPackagePreparing}
                      title="检查当前主机是否具备直接运行 CAMotics 的条件；不执行材料去除仿真"
                    >
                      <ClipboardCheck size={17} />
                      {isV3CamoticsPackagePreparing ? "检查中..." : "执行仿真预检"}
                    </button>
                    {v3Job.result.summary.camoticsExecutionPreflight && (
                      <small className={v3Job.result.summary.camoticsExecutionPreflight.canRunOnCurrentHost ? "v3-inline-ok" : "v3-inline-warning"}>
                        仿真预检：{v3Job.result.summary.camoticsExecutionPreflight.status}
                        {v3Job.result.summary.camoticsExecutionPreflight.command ? ` · ${v3Job.result.summary.camoticsExecutionPreflight.command}` : " · 需Linux CAM服务器"}
                        {v3Job.result.summary.camoticsExecutionPreflight.nextActions[0] ? ` · ${v3Job.result.summary.camoticsExecutionPreflight.nextActions[0]}` : ""}
                      </small>
                    )}
                    {v3Job.result.summary.camoticsCliPackage && (
                      <div className="v3-camotics-package-links">
                        <span>
                          准备包：{v3Job.result.summary.camoticsCliPackage.status}
                          {v3Job.result.summary.camoticsCliPackage.motionProfile?.motionLineCount
                            ? ` · 运动行 ${v3Job.result.summary.camoticsCliPackage.motionProfile.motionLineCount}`
                            : ""}
                        </span>
                        {[
                          v3Job.result.summary.camoticsCliPackage.artifact,
                          v3Job.result.summary.camoticsCliPackage.resultTemplate,
                          v3Job.result.summary.camoticsCliPackage.linuxRunScript,
                          v3Job.result.summary.camoticsCliPackage.resultValidator,
                          v3Job.result.summary.camoticsCliPackage.operatorChecklist,
                          v3Job.result.summary.camoticsCliPackage.report,
                          v3Job.result.summary.camoticsExecutionPreflight?.artifact,
                          v3Job.result.summary.camoticsExecutionPreflight?.report
                        ].filter((filename): filename is string => Boolean(filename)).map((filename) => (
                          <a
                            href={`/orchestrator-jobs/${v3Job.id}/${filename}`}
                            download
                            key={filename}
                          >
                            {formatV3ShortcutFileLabel(filename)}
                          </a>
                        ))}
                        <small>该准备包只用于仿真服务器；回填前先运行结果校验脚本，不会直接解锁生产 NC。</small>
                      </div>
                    )}
                    {(v3Job.result.summary as any).linuxCamJobValidation && (
                      <small className={(v3Job.result.summary as any).linuxCamJobValidation.level === "ready-for-v3-upload" ? "v3-inline-ok" : "v3-inline-warning"}>
                        Linux整单校验：{(v3Job.result.summary as any).linuxCamJobValidation.level}
                        {(v3Job.result.summary as any).linuxCamJobValidation.summary ? ` · ${(v3Job.result.summary as any).linuxCamJobValidation.summary}` : ""}
                      </small>
                    )}
                    <label>
                      <span>整单校验JSON</span>
                      <input
                        accept=".json,application/json"
                        type="file"
                        onChange={(event) => setV3LinuxCamJobValidationFile(event.target.files?.[0] ?? null)}
                      />
                      <small>{v3LinuxCamJobValidationFile?.name ?? "选择 linux-cam-job-local-validation.json"}</small>
                    </label>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleImportV3LinuxCamJobValidation}
                      disabled={!v3Job?.id || !v3LinuxCamJobValidationFile || isV3LinuxCamJobValidationImporting}
                    >
                      <UploadCloud size={17} />
                      {isV3LinuxCamJobValidationImporting ? "回填中..." : "回填整单校验"}
                    </button>
                    <label>
                      <span>结果ZIP</span>
                      <input
                        accept=".zip,application/zip"
                        type="file"
                        onChange={(event) => setV3CamoticsResultZipFile(event.target.files?.[0] ?? null)}
                      />
                      <small>{v3CamoticsResultZipFile?.name ?? "可直接上传 Linux 回传包"}</small>
                    </label>
                    <label>
                      <span>结果JSON</span>
                      <input
                        accept=".json,application/json"
                        type="file"
                        onChange={(event) => setV3CamoticsResultFile(event.target.files?.[0] ?? null)}
                      />
                      <small>{v3CamoticsResultFile?.name ?? "未选择"}</small>
                    </label>
                    <label>
                      <span>截图</span>
                      <input
                        accept="image/*"
                        type="file"
                        onChange={(event) => setV3CamoticsScreenshotFile(event.target.files?.[0] ?? null)}
                      />
                      <small>{v3CamoticsScreenshotFile?.name ?? "可选"}</small>
                    </label>
                    <label>
                      <span>材料STL</span>
                      <input
                        accept=".stl,model/stl,text/plain"
                        type="file"
                        onChange={(event) => setV3CamoticsMaterialMeshFile(event.target.files?.[0] ?? null)}
                      />
                      <small>{v3CamoticsMaterialMeshFile?.name ?? "可选"}</small>
                    </label>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={handleImportV3CamoticsResult}
                      disabled={!v3Job?.id || (!v3CamoticsResultFile && !v3CamoticsResultZipFile) || isV3CamoticsImporting}
                    >
                      <UploadCloud size={17} />
                      {isV3CamoticsImporting ? "回填中..." : "回填CAMotics结果"}
                    </button>
                  </div>
                  <div className="v3-action-row">
                    <button className="demo-action package-action" type="button" onClick={() => setActiveStage("feedback")}>
                      <ClipboardCheck size={17} />
                      记录试雕反馈
                    </button>
                    <button
                      className="demo-action package-action"
                      type="button"
                      onClick={syncV3MachineAcceptance}
                      disabled={!v3Job?.id || isV3MachineAcceptanceSyncing}
                    >
                      <ShieldCheck size={17} />
                      {isV3MachineAcceptanceSyncing ? "同步中..." : "同步机床验收"}
                    </button>
                  </div>
                </div>
              )}
              {v3Job?.result?.summary.meshQuality && (
                <small>
                  Mesh 评分 {v3Job.result.summary.meshQuality.score.toFixed(1)} / {v3Job.result.summary.meshQuality.verdict}
                  {" · "}
                  面 {v3Job.result.summary.meshQuality.triangleCount}
                  {" · "}
                  边界 {v3Job.result.summary.meshQuality.boundaryEdges}
                  {" · "}
                  非流形 {v3Job.result.summary.meshQuality.nonManifoldEdges}
                </small>
              )}
              {v3Job?.result?.summary.repairPlan && (
                <small>
                  修复计划：{v3Job.result.summary.repairPlan.statusText}
                  {v3Job.result.summary.repairPlan.recommendedActions[0] ? `，优先 ${v3Job.result.summary.repairPlan.recommendedActions[0].label}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.repairExecution && (
                <small>
                  修复执行：{v3Job.result.summary.repairExecution.status}
                  {" · "}
                  {v3Job.result.summary.repairExecution.summary}
                </small>
              )}
              {v3Job?.result?.summary.repairExecution?.importedRepair?.imported && (
                <small className="v3-inline-ok">
                  修复产物：已导入 {v3Job.result.summary.repairExecution.importedRepair.filename ?? "repaired-model.stl"}
                  {v3Job.result.summary.camInputPlan?.modelSelection?.selectedModelId === "repairedStl" ? " · 已作为CAM输入" : " · 未选中"}
                </small>
              )}
              {v3Job?.result?.summary.repairExecution?.repairedMeshQuality && (
                <small className={
                  v3Job.result.summary.repairExecution.repairedMeshQuality.error
                    ? "v3-inline-critical"
                    : v3Job.result.summary.repairExecution.repairedMeshQuality.verdict === "ready"
                      ? "v3-inline-ok"
                      : "v3-inline-warning"
                }>
                  修复后体检：
                  {typeof v3Job.result.summary.repairExecution.repairedMeshQuality.score === "number"
                    ? `${v3Job.result.summary.repairExecution.repairedMeshQuality.score.toFixed(1)}`
                    : "-"}
                  {" / "}
                  {v3Job.result.summary.repairExecution.repairedMeshQuality.verdict ?? "unknown"}
                  {" · "}
                  边界 {v3Job.result.summary.repairExecution.repairedMeshQuality.boundaryEdges ?? "-"}
                  {" · "}
                  非流形 {v3Job.result.summary.repairExecution.repairedMeshQuality.nonManifoldEdges ?? "-"}
                  {" · "}
                  退化面 {v3Job.result.summary.repairExecution.repairedMeshQuality.degenerateFaces ?? "-"}
                  {v3Job.result.summary.repairExecution.repairedMeshQuality.error ? ` · ${v3Job.result.summary.repairExecution.repairedMeshQuality.error}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.camInputPlan && (
                <small>
                  CAM输入：{v3Job.result.summary.camInputPlan.summary}
                  {" · "}
                  模型 {v3Job.result.summary.camInputPlan.modelSelection?.selectedModelId ?? v3Job.result.summary.camInputPlan.selectedModelKind}
                  {v3Job.result.summary.camInputPlan.modelSelection?.selectedModelRole ? `/${v3Job.result.summary.camInputPlan.modelSelection.selectedModelRole}` : ""}
                  {" · "}
                  {v3Job.result.summary.camInputPlan.gate.allowProductionNc ? "允许生产NC" : "仅建议试算/空跑"}
                </small>
              )}
              {v3Job?.result?.summary.camInputPlan?.modelSelection && (
                <small className={v3Job.result.summary.camInputPlan.modelSelection.blockingReason ? "v3-inline-critical" : v3Job.result.summary.camInputPlan.modelSelection.repairRequired ? "v3-inline-warning" : "v3-inline-ok"}>
                  CAM模型选择：{v3Job.result.summary.camInputPlan.modelSelection.selectionReason}
                  {" · "}
                  候选 {v3Job.result.summary.camInputPlan.modelSelection.candidates.filter((candidate) => candidate.exists).length}/{v3Job.result.summary.camInputPlan.modelSelection.candidates.length}
                  {v3Job.result.summary.camInputPlan.modelSelection.selectedModelRole && v3Job.result.summary.camInputPlan.modelSelection.selectedModelRole !== "source" ? ` · 使用${v3Job.result.summary.camInputPlan.modelSelection.selectedModelRole}模型` : ""}
                  {v3Job.result.summary.camInputPlan.modelSelection.blockingReason ? ` · ${v3Job.result.summary.camInputPlan.modelSelection.blockingReason}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.engineReadiness && (
                <small>
                  外部引擎：{v3Job.result.summary.engineReadiness.summary}
                  {" · "}
                  开关 {v3Job.result.summary.engineReadiness.enableExternalCamAdapters ? "已启用" : "未启用"}
                </small>
              )}
              {v3Job?.result?.summary.camEngineSelection && (
                <small className={v3Job.result.summary.camEngineSelection.externalAttemptAllowed ? "v3-inline-ok" : "v3-inline-warning"}>
                  CAM选择：{v3Job.result.summary.camEngineSelection.selectedEngineName}
                  {" · "}
                  {v3Job.result.summary.camEngineSelection.fallbackUsed ? "将降级/已降级" : "可尝试外部CAM"}
                  {" · "}
                  {v3Job.result.summary.camEngineSelection.fallbackReason}
                </small>
              )}
              {v3Job?.result?.summary.openSourceCamExecutionPlan && (
                <div className="v3-deployment-validation">
                  <small className={v3Job.result.summary.openSourceCamExecutionPlan.readyStageCount > 0 ? "v3-inline-warning" : "v3-inline-critical"}>
                    开源CAM执行计划：
                    {v3Job.result.summary.openSourceCamExecutionPlan.readyStageCount}/{v3Job.result.summary.openSourceCamExecutionPlan.totalStageCount}
                    {" · "}
                    {v3Job.result.summary.openSourceCamExecutionPlan.selectedEngineName}
                    {" · "}
                    {v3Job.result.summary.openSourceCamExecutionPlan.selectedStageStatus}
                  </small>
                  <div className="v3-adapter-list">
                    {v3Job.result.summary.openSourceCamExecutionPlan.stages?.slice(0, 4).map((stage) => (
                      <span className={stage.canAttemptNow ? "ok" : stage.selected ? "warning" : "critical"} key={stage.id} title={stage.acceptance}>
                        {stage.priority} · {stage.title}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {v3Job?.result?.summary.nativeCamReadiness && (
                <small>
                  Native CAM：{v3Job.result.summary.nativeCamReadiness.readyCount}/{v3Job.result.summary.nativeCamReadiness.requiredCount}
                  {" · "}
                  {v3Job.result.summary.nativeCamReadiness.level}
                  {" · "}
                  {v3Job.result.summary.nativeCamReadiness.summary}
                </small>
              )}
              {v3Job?.result?.summary.camServerConfig && (
                <>
                  <small className={v3Job.result.summary.camServerConfig.status === "ready-to-attempt-external-cam" ? "v3-inline-ok" : v3Job.result.summary.camServerConfig.status === "missing-native-dependencies" ? "v3-inline-critical" : "v3-inline-warning"}>
                    CAM服务器配置：{v3Job.result.summary.camServerConfig.status}
                    {" · "}
                    {v3Job.result.summary.camServerConfig.selectedEngineName}
                    {" · "}
                    缺失 {v3Job.result.summary.camServerConfig.missingRequired.length}
                  </small>
                  {v3Job.result.summary.camServerConfig.deploymentValidation && (
                    <div className="v3-deployment-validation">
                      <small>
                        加工包CAM验收：{v3Job.result.summary.camServerConfig.deploymentValidation.requiredAdapters.join(" / ") || "未指定"}
                        {" · "}
                        阶段 {v3Job.result.summary.camServerConfig.deploymentValidation.stages.length}
                      </small>
                      <div className="v3-adapter-list">
                        {v3Job.result.summary.camServerConfig.deploymentValidation.stages.slice(0, 5).map((stage) => (
                          <span className={stage.blocksProduction ? "warning" : "ok"} key={stage.id} title={stage.command}>
                            {stage.title}
                          </span>
                        ))}
                      </div>
                      {v3Job.result.summary.camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff[0] && (
                        <small className="v3-inline-warning">
                          生产必须关闭：{v3Job.result.summary.camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff.slice(0, 3).join("、")}
                        </small>
                      )}
                    </div>
                  )}
                </>
              )}
              {v3Job?.result?.summary.externalCamRecipe && (
                <small>
                  外部CAM配方：{v3Job.result.summary.externalCamRecipe.status}
                  {" · "}
                  {v3Job.result.summary.externalCamRecipe.engine.selectedEngineName}
                  {" · "}
                  工序 {v3Job.result.summary.externalCamRecipe.operations?.filter((operation) => operation.enabled).length ?? 0}/{v3Job.result.summary.externalCamRecipe.operations?.length ?? 0}
                </small>
              )}
              {v3Job?.result?.summary.adapterPreflight && (
                <small>
                  Adapter预检：{v3Job.result.summary.adapterPreflight.status}
                  {" · "}
                  {v3Job.result.summary.adapterPreflight.summary}
                </small>
              )}
              {v3Job?.result?.summary.productionGate && (
                <small>
                  生产门禁：{v3Job.result.summary.productionGate.summary}
                  {" · "}
                  空跑 {v3Job.result.summary.productionGate.allowAirRun ? "可用" : "不可用"}
                  {" · "}
                  试雕 {v3Job.result.summary.productionGate.allowTrialNc ? "可用" : "不可用"}
                </small>
              )}
              {v3Job?.result?.summary.productionUnlockMatrix && (
                <small className={v3Job.result.summary.productionUnlockMatrix.allowProductionNc ? "v3-inline-ok" : v3Job.result.summary.productionUnlockMatrix.blockCount > 0 ? "v3-inline-critical" : "v3-inline-warning"}>
                  解锁矩阵：通过 {v3Job.result.summary.productionUnlockMatrix.passCount}
                  {" · "}
                  复核 {v3Job.result.summary.productionUnlockMatrix.reviewCount}
                  {" · "}
                  阻断 {v3Job.result.summary.productionUnlockMatrix.blockCount}
                </small>
              )}
              {v3Job?.result?.summary.productionEvidenceDossier && (
                <>
                  <small className={v3Job.result.summary.productionEvidenceDossier.status === "production-evidence-complete" ? "v3-inline-ok" : v3Job.result.summary.productionEvidenceDossier.blockedCount > 0 ? "v3-inline-critical" : "v3-inline-warning"}>
                    证据档案：{v3Job.result.summary.productionEvidenceDossier.status}
                    {" · "}
                    通过 {v3Job.result.summary.productionEvidenceDossier.passedCount}
                    {" · "}
                    复核 {v3Job.result.summary.productionEvidenceDossier.reviewCount}
                    {" · "}
                    阻断 {v3Job.result.summary.productionEvidenceDossier.blockedCount}
                    {v3Job.result.summary.productionEvidenceDossier.missingEvidenceCount
                      ? ` · 缺口 ${v3Job.result.summary.productionEvidenceDossier.missingEvidenceCount}`
                      : ""}
                  </small>
                  {v3Job.result.summary.productionEvidenceDossier.fieldEvidenceGaps?.length ? (
                    <small className="v3-inline-warning">
                      现场证据缺口：
                      {v3Job.result.summary.productionEvidenceDossier.fieldEvidenceGaps
                        .slice(0, 4)
                        .map((item) => item.label)
                        .join("、")}
                    </small>
                  ) : null}
                  {v3Job.result.summary.productionEvidenceDossier.evidenceItems?.length ? (
                    <div className="v3-evidence-grid compact">
                      {v3Job.result.summary.productionEvidenceDossier.evidenceItems.slice(0, 6).map((item) => (
                        <div className={item.status === "pass" ? "ok" : item.status === "block" ? "critical" : "warning"} key={item.id} title={item.summary}>
                          <span>{item.label}</span>
                          <strong>{formatEvidenceItemStatus(item.status)}</strong>
                          <small>{item.summary}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {v3Job.result.summary.productionEvidenceDossier.crossChecks ? (
                    <div className="v3-evidence-grid compact">
                      {createProductionCrossCheckTiles(v3Job.result.summary.productionEvidenceDossier.crossChecks).map((item) => (
                        <div className={item.level} key={item.label} title={item.detail}>
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                          <small>{item.detail}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
              {v3Job?.result?.summary.machineAcceptanceLog && (
                <small className={v3Job.result.summary.machineAcceptanceLog.allRequiredPassed ? "v3-inline-ok" : v3Job.result.summary.machineAcceptanceLog.latestOutcome === "failed" ? "v3-inline-critical" : "v3-inline-warning"}>
                  机床验收：{v3Job.result.summary.machineAcceptanceLog.latestOutcome}
                  {" · "}
                  记录 {v3Job.result.summary.machineAcceptanceLog.recordCount}
                  {" · "}
                  必需项 {v3Job.result.summary.machineAcceptanceLog.allRequiredPassed ? "已通过" : "待复核"}
                </small>
              )}
              {v3Job?.result?.summary.productionGate?.simulationEvidence && (
                <small className={v3Job.result.summary.productionGate.simulationEvidence.productionUnlockEligible ? "v3-inline-ok" : v3Job.result.summary.productionGate.simulationEvidence.synthetic ? "v3-inline-warning" : "v3-inline-critical"}>
                  仿真证据：{v3Job.result.summary.productionGate.simulationEvidence.level}
                  {v3Job.result.summary.productionGate.simulationEvidence.evidenceQuality?.status ? ` / ${v3Job.result.summary.productionGate.simulationEvidence.evidenceQuality.status}` : ""}
                  {" · "}
                  {v3Job.result.summary.productionGate.simulationEvidence.summary}
                  {v3Job.result.summary.productionGate.simulationEvidence.evidenceQuality?.missing?.length
                    ? ` · 缺失 ${v3Job.result.summary.productionGate.simulationEvidence.evidenceQuality.missing.join(", ")}`
                    : ""}
                </small>
              )}
              {v3Job?.result?.summary.postprocessProfile && (
                <small>
                  后处理：{v3Job.result.summary.postprocessProfile.postProcessorName}
                  {" · "}
                  长度轴 {v3Job.result.summary.postprocessProfile.coordinateMapping?.lengthAxis ?? "X"}
                  {" · "}
                  旋转轴 {v3Job.result.summary.postprocessProfile.coordinateMapping?.rotaryAxis ?? "无"}
                  {v3Job.result.summary.postprocessProfile.machine?.rotaryWrapPerRevolutionMm
                    ? ` · ${v3Job.result.summary.postprocessProfile.machine.rotaryWrapPerRevolutionMm}mm/圈`
                    : ""}
                  {" · "}
                  刀具 {v3Job.result.summary.postprocessProfile.tool?.description ?? "未记录"}
                </small>
              )}
              {v3Job?.result?.summary.machineControllerProfile && (
                <small>
                  机床配置：{v3Job.result.summary.machineControllerProfile.name}
                  {" · "}
                  长度 {v3Job.result.summary.machineControllerProfile.axisMapping?.lengthAxis ?? "X"}
                  {" · "}
                  刀深 {v3Job.result.summary.machineControllerProfile.axisMapping?.depthAxis ?? "Z"}
                  {" · "}
                  旋转 {v3Job.result.summary.machineControllerProfile.rotary?.outputAxis ?? "无"}
                  {v3Job.result.summary.machineControllerProfile.rotary?.wrapPerRevolutionMm
                    ? ` · ${v3Job.result.summary.machineControllerProfile.rotary.wrapPerRevolutionMm}mm/圈`
                    : ""}
                </small>
              )}
              {v3Job?.result?.summary.ncStaticAnalysis && (
                <small>
                  NC静态分析：{v3Job.result.summary.ncStaticAnalysis.level}
                  {" · "}
                  阻断 {v3Job.result.summary.ncStaticAnalysis.criticalIssues.length}
                  {" · "}
                  复核 {v3Job.result.summary.ncStaticAnalysis.warningIssues.length}
                  {" · "}
                  程序 {v3Job.result.summary.ncStaticAnalysis.programs.length}
                </small>
              )}
              {v3Job?.result?.summary.camHandoffQuality && (
                <small className={v3Job.result.summary.camHandoffQuality.level === "ready" ? "v3-inline-ok" : v3Job.result.summary.camHandoffQuality.level === "critical" ? "v3-inline-critical" : "v3-inline-warning"}>
                  CAM交接质量：{v3Job.result.summary.camHandoffQuality.level}
                  {" · "}
                  {v3Job.result.summary.camHandoffQuality.source}
                  {" · "}
                  点 {v3Job.result.summary.camHandoffQuality.metrics.pointCount}
                  {" · "}
                  X覆盖 {(v3Job.result.summary.camHandoffQuality.metrics.xCoverage * 100).toFixed(1)}%
                  {v3Job.result.summary.camHandoffQuality.metrics.rotaryCoverage !== null
                    ? ` · 旋转覆盖 ${(v3Job.result.summary.camHandoffQuality.metrics.rotaryCoverage * 100).toFixed(1)}%`
                    : ""}
                  {v3Job.result.summary.camHandoffQuality.metrics.samplingQuality
                    ? ` · 采样 ${v3Job.result.summary.camHandoffQuality.metrics.samplingQuality.level ?? "-"}`
                    : ""}
                  {v3Job.result.summary.camHandoffQuality.metrics.samplingQuality
                    ? ` · ${v3Job.result.summary.camHandoffQuality.metrics.samplingQuality.adaptiveSampling ? "自适应" : "手动"}`
                    : ""}
                  {v3Job.result.summary.camHandoffQuality.metrics.samplingQuality?.stepToCutterRatio !== null && v3Job.result.summary.camHandoffQuality.metrics.samplingQuality?.stepToCutterRatio !== undefined
                    ? ` · step/cutter ${v3Job.result.summary.camHandoffQuality.metrics.samplingQuality.stepToCutterRatio.toFixed(3)}`
                    : ""}
                  {v3Job.result.summary.camHandoffQuality.metrics.samplingQuality?.rowCapHit || v3Job.result.summary.camHandoffQuality.metrics.samplingQuality?.colCapHit
                    ? " · 已触达采样上限"
                    : ""}
                </small>
              )}
              {v3Job?.result?.summary.neutralToolpathImportValidation && (
                <small className={v3Job.result.summary.neutralToolpathImportValidation.postprocessEligible ? v3Job.result.summary.neutralToolpathImportValidation.status === "ready" ? "v3-inline-ok" : "v3-inline-warning" : "v3-inline-critical"}>
                  Neutral导入校验：{v3Job.result.summary.neutralToolpathImportValidation.status}
                  {" · "}
                  {v3Job.result.summary.neutralToolpathImportValidation.postprocessEligible ? "可进入后处理" : "已拒绝"}
                  {" · "}
                  点 {v3Job.result.summary.neutralToolpathImportValidation.metrics?.sourcePointCount ?? "-"}
                  {v3Job.result.summary.neutralToolpathImportValidation.metrics?.outOfRangeCount
                    ? ` · 越界 ${v3Job.result.summary.neutralToolpathImportValidation.metrics.outOfRangeCount}`
                    : ""}
                  {v3Job.result.summary.neutralToolpathImportValidation.classification?.previewScaffold
                    ? " · preview/scaffold"
                    : ""}
                  {" · "}
                  {v3Job.result.summary.neutralToolpathImportValidation.summary}
                </small>
              )}
              {v3Job?.result?.summary.neutralToolpathImportValidation?.machineFit && (
                <small className={v3Job.result.summary.neutralToolpathImportValidation.machineFit.level === "ok" ? "v3-inline-ok" : v3Job.result.summary.neutralToolpathImportValidation.machineFit.level === "critical" ? "v3-inline-critical" : "v3-inline-warning"}>
                  机床适配：{v3Job.result.summary.neutralToolpathImportValidation.machineFit.level}
                  {" · "}
                  {v3Job.result.summary.neutralToolpathImportValidation.machineFit.targetMachine?.axisMapping ?? "三轴/Y旋转夹具"}
                  {" · "}
                  X覆盖 {v3Job.result.summary.neutralToolpathImportValidation.machineFit.coverage?.xCoverageRatio !== undefined ? `${(v3Job.result.summary.neutralToolpathImportValidation.machineFit.coverage.xCoverageRatio * 100).toFixed(1)}%` : "-"}
                  {" · "}
                  旋转 {v3Job.result.summary.neutralToolpathImportValidation.machineFit.coverage?.rotarySpanDeg !== undefined ? `${v3Job.result.summary.neutralToolpathImportValidation.machineFit.coverage.rotarySpanDeg.toFixed(1)}°` : "-"}
                  {v3Job.result.summary.neutralToolpathImportValidation.machineFit.riskCounts?.holdZonePointCount
                    ? ` · 端部风险 ${v3Job.result.summary.neutralToolpathImportValidation.machineFit.riskCounts.holdZonePointCount}`
                    : ""}
                  {v3Job.result.summary.neutralToolpathImportValidation.machineFit.riskCounts?.deepPointCount
                    ? ` · 超深 ${v3Job.result.summary.neutralToolpathImportValidation.machineFit.riskCounts.deepPointCount}`
                    : ""}
                  {" · "}
                  {v3Job.result.summary.neutralToolpathImportValidation.machineFit.summary}
                </small>
              )}
              {findV3DeliveryFile(v3Job, "opencamlib-cutter-envelope-report.json") && (
                <small className="v3-inline-warning">
                  OpenCAMLib包络：preview审计报告
                  {" · "}
                  {v3Job?.result?.adapterReport?.metrics?.neutralToolpath?.cutterEnvelopeReportPath ? "已绑定runner输出" : "已列入加工包"}
                  {v3Job?.result?.adapterReport?.metrics?.neutralToolpath?.pointCount
                    ? ` · ${v3Job.result.adapterReport.metrics.neutralToolpath.pointCount}点`
                    : ""}
                  {v3Job?.result?.adapterReport?.metrics?.neutralToolpath?.previewScaffold ? " · 不解锁生产" : ""}
                </small>
              )}
              {v3Job?.result?.summary.rotaryWrapPreviewReport && (
                <div className={`v3-rotary-preview-card ${v3Job.result.summary.rotaryWrapPreviewReport.level}`}>
                  <div>
                    <strong>旋转包裹预览：{v3Job.result.summary.rotaryWrapPreviewReport.level}</strong>
                    <span>{v3Job.result.summary.rotaryWrapPreviewReport.summary}</span>
                  </div>
                  <div className="v3-rotary-preview-grid">
                    <span>
                      <strong>{v3Job.result.summary.rotaryWrapPreviewReport.metrics.machineCoverage !== null ? `${(v3Job.result.summary.rotaryWrapPreviewReport.metrics.machineCoverage * 100).toFixed(1)}%` : "-"}</strong>
                      机床NC覆盖
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.rotaryWrapPreviewReport.metrics.pointCoverage !== null ? `${(v3Job.result.summary.rotaryWrapPreviewReport.metrics.pointCoverage * 100).toFixed(1)}%` : "-"}</strong>
                      刀路点覆盖
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.rotaryWrapPreviewReport.metrics.linearizationErrorRate !== null ? `${(v3Job.result.summary.rotaryWrapPreviewReport.metrics.linearizationErrorRate * 100).toFixed(2)}%` : "-"}</strong>
                      线性化误差
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.rotaryWrapPreviewReport.coordinateMapping.rotaryAxis ?? "-"}</strong>
                      {v3Job.result.summary.rotaryWrapPreviewReport.coordinateMapping.rotaryOutputMode}
                    </span>
                  </div>
                  <small>
                    目标 {v3Job.result.summary.rotaryWrapPreviewReport.coordinateMapping.expectedAngleSpanDeg ?? "-"}°
                    {" · "}
                    每圈 {v3Job.result.summary.rotaryWrapPreviewReport.coordinateMapping.rotaryWrapPerRevolutionMm ?? "-"}mm
                    {" · "}
                    预览 {v3Job.result.summary.rotaryWrapPreviewReport.coordinateMapping.camoticsInterpretation ?? "-"}
                  </small>
                  {(v3Job.result.summary.rotaryWrapPreviewReport.criticalIssues[0] || v3Job.result.summary.rotaryWrapPreviewReport.warningIssues[0]) && (
                    <small>
                      复核：{v3Job.result.summary.rotaryWrapPreviewReport.criticalIssues[0] ?? v3Job.result.summary.rotaryWrapPreviewReport.warningIssues[0]}
                    </small>
                  )}
                </div>
              )}
              {v3Job?.result?.summary.postprocessTraceReport && (
                <div className={`v3-rotary-preview-card ${v3Job.result.summary.postprocessTraceReport.level}`}>
                  <div>
                    <strong>后处理追溯：{v3Job.result.summary.postprocessTraceReport.level}</strong>
                    <span>{v3Job.result.summary.postprocessTraceReport.summary}</span>
                  </div>
                  <div className="v3-rotary-preview-grid">
                    <span>
                      <strong>{(v3Job.result.summary.postprocessTraceReport.metrics.fitRate * 100).toFixed(2)}%</strong>
                      点位匹配
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.postprocessTraceReport.metrics.matched}/{v3Job.result.summary.postprocessTraceReport.metrics.compared}</strong>
                      已核对
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.postprocessTraceReport.metrics.maxAbs.lengthMm.toFixed(4)}mm</strong>
                      长度偏差
                    </span>
                    <span>
                      <strong>{v3Job.result.summary.postprocessTraceReport.metrics.maxAbs.zMm.toFixed(4)}mm</strong>
                      Z偏差
                    </span>
                  </div>
                  <small>
                    源点 {v3Job.result.summary.postprocessTraceReport.source.pointCount}
                    {" · "}
                    机床运动 {v3Job.result.summary.postprocessTraceReport.machineNc.cuttingMoveCount}
                    {" · "}
                    {v3Job.result.summary.postprocessTraceReport.coordinateMapping.lengthAxis}/
                    {v3Job.result.summary.postprocessTraceReport.coordinateMapping.rotaryAxis ?? "-"}/
                    {v3Job.result.summary.postprocessTraceReport.coordinateMapping.depthAxis}
                    {" · "}
                    缺失 {v3Job.result.summary.postprocessTraceReport.metrics.missingMoves}
                    {" · "}
                    多余 {v3Job.result.summary.postprocessTraceReport.metrics.extraMoves}
                  </small>
                  {(v3Job.result.summary.postprocessTraceReport.criticalIssues[0] || v3Job.result.summary.postprocessTraceReport.warningIssues[0]) && (
                    <small>
                      复核：{v3Job.result.summary.postprocessTraceReport.criticalIssues[0] ?? v3Job.result.summary.postprocessTraceReport.warningIssues[0]}
                    </small>
                  )}
                  {findV3DeliveryFile(v3Job, "postprocess-trace-report.json") && (
                    <a href={findV3DeliveryFile(v3Job, "postprocess-trace-report.json")?.url} download>
                      下载后处理追溯报告
                    </a>
                  )}
                </div>
              )}
              {v3Job?.result?.summary.controllerDialectReport && (
                <small>
                  控制器方言：{v3Job.result.summary.controllerDialectReport.level}
                  {" · "}
                  {v3Job.result.summary.controllerDialectReport.dialect.name}
                  {" · "}
                  阻断 {v3Job.result.summary.controllerDialectReport.criticalIssues.length}
                  {" · "}
                  复核 {v3Job.result.summary.controllerDialectReport.warningIssues.length}
                </small>
              )}
              {v3Job?.result?.summary.deliveryManifest && (
                <small>
                  交付清单：{v3Job.result.summary.deliveryManifest.files.filter((file) => file.downloadable).length}/{v3Job.result.summary.deliveryManifest.files.length} 个文件可下载
                </small>
              )}
              {v3DeliveryShortcutFiles.length > 0 && (
                <div className="v3-delivery-shortcuts" aria-label="V3关键交付文件">
                  <span>上机前顺序</span>
                  {v3DeliveryShortcutFiles.map((file, index) => (
                    <a
                      className={!file.downloadable ? "disabled" : ""}
                      download={file.downloadable}
                      href={file.url}
                      key={file.filename}
                      onClick={(event) => {
                        if (!file.downloadable) event.preventDefault();
                      }}
                      title={file.note}
                    >
                      {index + 1}. {formatV3ShortcutFileLabel(file.filename)}
                    </a>
                  ))}
                </div>
              )}
              {v3Job?.result?.summary.packageIntegrity && (
                <small className={v3Job.result.summary.packageIntegrity.status === "complete" ? "v3-inline-ok" : "v3-inline-critical"}>
                  完整性：{v3Job.result.summary.packageIntegrity.status}
                  {" · "}
                  文件 {v3Job.result.summary.packageIntegrity.downloadableCount}/{v3Job.result.summary.packageIntegrity.fileCount}
                  {" · "}
                  缺失 {v3Job.result.summary.packageIntegrity.missingDownloadableCount}
                </small>
              )}
              {v3DownloadChecklistSummary && (
                <div className="v3-download-checklist">
                  <small>
                    下载核验：关键文件 {v3DownloadChecklistSummary.verifiedKeyCount}/{v3DownloadChecklistSummary.keyFiles.length}
                    {" · "}
                    禁止上机 {v3DownloadChecklistSummary.neverMachineCount}
                  </small>
                  <div className="v3-machine-file-grid">
                    {v3DownloadChecklistSummary.keyFiles.map((file) => (
                      <div className={`v3-machine-file-card ${getV3MachineFileCardClass(file)}`} key={file.filename}>
                        <div>
                          <strong>{formatV3ShortcutFileLabel(file.filename)}</strong>
                          <span>{formatV3MachineUseClass(file.machineUseClass)}</span>
                        </div>
                        <p>{file.summary}</p>
                        <small>
                          {file.verified ? "SHA-256 已记录" : "缺少 SHA-256"}
                          {" · "}
                          {file.allowedOnMachine ? file.spindleExpected ? "可能启动主轴" : "仅空跑" : "禁止上机"}
                          {file.requiresGate ? " · 受门禁控制" : ""}
                        </small>
                      </div>
                    ))}
                  </div>
                  {v3DownloadChecklistSummary.checklistUrl && (
                    <a href={v3DownloadChecklistSummary.checklistUrl} download>
                      下载操作员核验清单
                    </a>
                  )}
                  {v3DownloadChecklistSummary.closedLoopHandoffUrl && (
                    <a href={v3DownloadChecklistSummary.closedLoopHandoffUrl} download>
                      下载闭环交接说明
                    </a>
                  )}
                  {v3DownloadChecklistSummary.camHandoffEvidenceUrl && (
                    <a href={v3DownloadChecklistSummary.camHandoffEvidenceUrl} download>
                      下载CAM交接证据
                    </a>
                  )}
                </div>
              )}
              {v3Job?.result?.summary.operatorRunbook && (
                <small className="v3-inline-ok">
                  操作员说明：{v3Job.result.summary.operatorRunbook.artifact}
                  {" · "}
                  {v3Job.result.summary.operatorRunbook.summary}
                </small>
              )}
              {v3Job?.result?.summary.trialFeedbackTemplate && (
                <small className="v3-inline-ok">
                  试雕反馈：trial-feedback-template.json
                  {" · "}
                  缺陷标签 {v3Job.result.summary.trialFeedbackTemplate.issueOptions.length}
                </small>
              )}
              {v3Job?.result?.summary.trialFeedbackLog && (
                <small className={v3Job.result.summary.trialFeedbackLog.latestOutcome === "success" ? "v3-inline-ok" : v3Job.result.summary.trialFeedbackLog.latestOutcome === "failed" ? "v3-inline-critical" : "v3-inline-warning"}>
                  反馈回填：{v3Job.result.summary.trialFeedbackLog.recordCount} 条
                  {" · "}
                  最新 {formatFeedbackOutcome(v3Job.result.summary.trialFeedbackLog.latestOutcome)}
                  {" · "}
                  {v3Job.result.summary.trialFeedbackLog.artifact}
                </small>
              )}
              {v3Job?.result?.summary.processOptimizationPlan && (
                <small className={v3Job.result.summary.processOptimizationPlan.status === "candidate-success-profile" ? "v3-inline-ok" : v3Job.result.summary.processOptimizationPlan.status === "requires-calibration" ? "v3-inline-critical" : "v3-inline-warning"}>
                  工艺优化：{v3Job.result.summary.processOptimizationPlan.actionCount} 项
                  {" · "}
                  {v3Job.result.summary.processOptimizationPlan.status}
                  {" · "}
                  {v3Job.result.summary.processOptimizationPlan.nextRunProfile.requiresRegeneration ? "需重新生成" : "无需重算"}
                </small>
              )}
              {v3Job?.result?.summary.toolSetupSheet && (
                <small className={v3Job.result.summary.toolSetupSheet.warnings.length > 0 ? "v3-inline-warning" : "v3-inline-ok"}>
                  刀具核验：{v3Job.result.summary.toolSetupSheet.tool.name}
                  {" · "}
                  切深 {v3Job.result.summary.toolSetupSheet.cutting.maxCutDepthMm.toFixed(3)}mm
                  {" · "}
                  步距 {v3Job.result.summary.toolSetupSheet.cutting.stepoverMm.toFixed(3)}mm
                  {" · "}
                  复核 {v3Job.result.summary.toolSetupSheet.warnings.length}
                </small>
              )}
              {v3Job?.result?.summary.rotaryCalibrationSheet && (
                <small className={v3Job.result.summary.rotaryCalibrationSheet.warnings.length > 0 ? "v3-inline-warning" : "v3-inline-ok"}>
                  旋转标定：{v3Job.result.summary.rotaryCalibrationSheet.axisMapping.rotaryAxis ?? "无"}
                  {" · "}
                  {v3Job.result.summary.rotaryCalibrationSheet.axisMapping.rotaryWrapPerRevolutionMm
                    ? `${v3Job.result.summary.rotaryCalibrationSheet.axisMapping.rotaryWrapPerRevolutionMm.toFixed(3)}mm/圈`
                    : "非旋转"}
                  {" · "}
                  复核 {v3Job.result.summary.rotaryCalibrationSheet.warnings.length}
                </small>
              )}
              {v3Job?.result?.summary.machineAcceptanceChecklist && (
                <small className={v3Job.result.summary.machineAcceptanceChecklist.steps.some((step) => step.blocksProduction) ? "v3-inline-warning" : "v3-inline-ok"}>
                  机床验收：{v3Job.result.summary.machineAcceptanceChecklist.summary}
                  {" · "}
                  步骤 {v3Job.result.summary.machineAcceptanceChecklist.steps.length}
                  {" · "}
                  阻断 {v3Job.result.summary.machineAcceptanceChecklist.steps.filter((step) => step.blocksProduction).length}
                </small>
              )}
              {v3Job?.result && (
                <small>
                  引擎 {v3Job.result.engine} / 点数 {v3Job.result.summary.points} / 预览点 {v3Job.result.summary.previewPoints} / {v3Job.result.summary.estimatedMinutes.toFixed(1)} min
                </small>
              )}
              {v3Job?.result?.adapterReport && (
                <small>
                  外部 adapter {v3Job.result.adapterReport.engine} / {v3Job.result.adapterReport.status}
                  {v3Job.result.adapterReport.error ? ` / ${v3Job.result.adapterReport.error}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.simulation && (
                <small>
                  仿真 {v3Job.result.summary.simulation.engine} / 贴合 {v3Job.result.summary.simulation.metrics.fitRate.toFixed(1)}% / 未命中 {v3Job.result.summary.simulation.metrics.missCount}
                </small>
              )}
              {v3Job?.result?.camoticsAdapterReport && (
                <small className={v3Job.result.camoticsAdapterReport.status === "completed" ? "v3-inline-ok" : v3Job.result.camoticsAdapterReport.status === "skipped" ? "v3-inline-warning" : "v3-inline-critical"}>
                  CAMotics Adapter：{v3Job.result.camoticsAdapterReport.status}
                  {v3Job.result.camoticsAdapterReport.error ? ` · ${v3Job.result.camoticsAdapterReport.error}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.simulation?.camoticsAdapter && (
                <small className={v3Job.result.summary.simulation.camoticsAdapter.synthetic ? "v3-inline-warning" : v3Job.result.summary.simulation.camoticsAdapter.status === "completed" ? "v3-inline-ok" : "v3-inline-critical"}>
                  CAMotics结果：{v3Job.result.summary.simulation.camoticsAdapter.synthetic ? "synthetic链路验证" : "材料去除仿真"}
                  {" · "}
                  {v3Job.result.summary.simulation.camoticsAdapter.status}
                  {v3Job.result.summary.simulation.camoticsAdapter.metrics?.motionLineCount ? ` · 运动行 ${v3Job.result.summary.simulation.camoticsAdapter.metrics.motionLineCount}` : ""}
                  {v3Job.result.summary.machiningPackageIndex?.camotics?.machineContextStatus ? ` · machine ${v3Job.result.summary.machiningPackageIndex.camotics.machineContextStatus}` : ""}
                  {v3Job.result.summary.machiningPackageIndex?.camotics?.resultFile ? ` · ${v3Job.result.summary.machiningPackageIndex.camotics.resultFile}` : ""}
                </small>
              )}
              {v3Job?.result?.summary.camoticsInput && (
                <small>
                  CAMotics输入：{v3Job.result.summary.camoticsInput.status}
                  {" · "}
                  {v3Job.result.summary.camoticsInput.compatibility.canRunInCamotics ? "可做三轴展开检查" : "需旋转轴仿真复核"}
                  {" · "}
                  {v3Job.result.summary.camoticsInput.compatibility.interpretation}
                </small>
              )}
              {v3Job?.result?.summary.machiningPackageIndex && (
                <small>
                  加工包索引：{v3Job.result.summary.machiningPackageIndex.packageLevel}
                  {" · "}
                  生产NC {v3Job.result.summary.machiningPackageIndex.gates?.allowProductionNc ? "允许" : "未解锁"}
                  {" · "}
                  试雕 {v3Job.result.summary.machiningPackageIndex.gates?.allowTrialNc ? "可用" : "不可用"}
                  {" · "}
                  空跑 {v3Job.result.summary.machiningPackageIndex.gates?.allowAirRun ? "可用" : "不可用"}
                </small>
              )}
            </div>
            {v3Job && (
              <div className="v3-log-list">
                {v3Job.logs.slice(-4).map((log) => (
                  <span key={`${log.time}-${log.message}`}>{log.message}</span>
                ))}
              </div>
            )}
            {v3Job?.artifacts && v3Job.artifacts.length > 0 && (
              <div className="v3-artifact-list">
                {v3Job.artifacts.map((artifact) => (
                  <a href={artifact} target="_blank" rel="noreferrer" key={artifact}>
                    {extractDownloadFilename(artifact, artifact)}
                  </a>
                ))}
              </div>
            )}
            {v3JobHistory.length > 0 && (
              <div className="v3-history-list">
                <div className="v3-history-heading">
                  <strong>最近任务</strong>
                  <button type="button" onClick={refreshV3JobHistory}>刷新</button>
                </div>
                {v3JobHistory.slice(0, 5).map((job) => (
                  <button className="v3-history-item" type="button" onClick={() => handleLoadV3Job(job.id)} key={job.id}>
                    <span>{job.id.slice(0, 8)} · {job.status} · {job.packageLevel ?? "no-package"} · {Math.round(job.progress ?? 0)}%</span>
                    <small>{job.currentStage ?? "queued"} · {job.points ? `${job.points} 点` : "无刀路"} · {job.updatedAt.slice(0, 19).replace("T", " ")}</small>
                  </button>
                ))}
              </div>
            )}
            {!V3_TRIAL_FOCUSED_UI && (
              <button className="primary-action package-action" onClick={handleRunV3OrchestratorLoop} disabled={!isModelReadyForCam || isV3JobRunning} type="button">
                <Cloud size={17} />
                {isV3JobRunning ? "闭环运行中..." : "生成试雕刀路与安全包"}
              </button>
            )}
            {v3Job && (v3Job.status === "queued" || v3Job.status === "running") && (
              <button className="demo-action package-action" onClick={handleCancelV3Job} type="button">
                <Trash2 size={17} />
                取消 V3 任务
              </button>
            )}
            {!V3_TRIAL_FOCUSED_UI && (
              <button className="primary-action package-action" onClick={handleDownloadV3TrialPackage} disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading} type="button" title="只包含空跑、标定、说明、报告，以及被 V3 试雕门禁允许的 toolpath.nc">
                <Download size={17} />
                {isV3PackageDownloading ? "正在打包..." : "下载安全试雕包"}
              </button>
            )}
            {!V3_TRIAL_FOCUSED_UI && (
              <button className="demo-action package-action" onClick={handleDownloadV3Package} disabled={!v3Job?.result?.summary.deliveryManifest || isV3PackageDownloading} type="button">
                <Download size={17} />
                下载 V3 工程包
              </button>
            )}
          </section>
        )}

        {!V3_TRIAL_FOCUSED_UI && activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Download size={18} />
              <h2>加工包交付</h2>
            </div>
            <p className="panel-note">下载完整加工包，包含 NC/TAP/TXT/CSV、质量报告、安全校验、成本估算和上机说明。</p>
            {v3DownloadChecklistSummary && (
              <div className="v3-download-checklist package-safety-summary">
                <small>
                  V3 上机文件核验：先看用途，再下载；CAMotics 预览文件永远不要上机。
                </small>
                <div className="v3-machine-file-grid">
                  {v3DownloadChecklistSummary.keyFiles.map((file) => (
                    <div className={`v3-machine-file-card ${getV3MachineFileCardClass(file)}`} key={`package-${file.filename}`}>
                      <div>
                        <strong>{file.filename}</strong>
                        <span>{formatV3MachineUseClass(file.machineUseClass)}</span>
                      </div>
                      <p>{file.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="package-list">
              <span>离料空跑 NC</span>
              <span>合并 NC</span>
              <span>粗加工 NC</span>
              <span>精加工 NC</span>
              <span>清残 NC</span>
              <span>CSV 点位</span>
              <span>参数快照</span>
              <span>仿真截图</span>
              <span>源模型</span>
              <span>质量报告</span>
              <span>安全报告</span>
              <span>交付清单</span>
            </div>
            {v3ProductionDownloadLocked && (
              <div className="v3-production-lock-note">
                <strong>V3 正式 NC 未解锁</strong>
                <span>{v3ProductionGate?.summary ?? "当前仅允许空跑或低风险试雕包，不能下载正式生产 NC。"}</span>
              </div>
            )}
            <button className="primary-action package-action" onClick={handleDownloadZipPackage} disabled={!formalDownloadAllowed} type="button" title={productionDownloadTitle}>
              <Download size={17} />
              下载 ZIP 加工包
            </button>
            <button className="demo-action package-action" onClick={handleDownloadAirRun} disabled={!canDownloadAirRun} type="button" title="主轴关闭，Z 保持安全高度，用于离料空跑验证机器动作">
              <Download size={17} />
              下载离料空跑 NC
            </button>
            <button className="demo-action package-action" onClick={handleDownloadOperatorPackage} disabled={!canDownloadOperatorPackage} type="button">
              <Download size={17} />
              下载加工包说明
            </button>
          </section>
        )}

        {activeStage === "tasks" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>任务中心</h2>
              </div>
              <div className="task-summary">
                <span><strong>{taskEvents.length}</strong> 事件</span>
                <span><strong>{taskJobs.filter((job) => job.status === "running").length}</strong> 运行中</span>
                <span><strong>{taskEvents.filter((event) => event.status === "ok").length}</strong> 成功</span>
                <span><strong>{taskEvents.filter((event) => event.status === "warning").length}</strong> 提醒</span>
                <span><strong>{taskEvents.filter((event) => event.status === "error").length}</strong> 失败</span>
                <span><strong>{taskJobs.filter((job) => job.status === "canceled").length}</strong> 已取消</span>
              </div>
              <button className="demo-action package-action" onClick={() => { setTaskEvents([]); setTaskJobs([]); setSelectedTaskJobId(null); }} disabled={taskEvents.length === 0 && taskJobs.length === 0} type="button">
                清空任务记录
              </button>
              <button className="demo-action package-action" onClick={handleSaveCurrentSnapshot} type="button">
                保存当前参数版本
              </button>
            </section>
            <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>任务队列</h2>
              </div>
              {taskJobs.length === 0 ? (
                <p className="panel-note">AI 生成、Mesh 修复、重网格、CAM 生成等长任务会显示在这里。</p>
              ) : (
                <div className="job-list">
                  {taskJobs.map((job) => (
                    <div className={`job-card ${job.status}`} key={job.id}>
                      <div>
                        <strong>{job.title}</strong>
                        <span>{formatTaskJobStatus(job.status)}</span>
                      </div>
                      <p>{job.detail}</p>
                      <div className="job-progress" aria-label={`${job.title}进度`}>
                        <i style={{ width: `${job.progress}%` }} />
                      </div>
                      <small>
                        {job.category.toUpperCase()} / 开始 {job.startedLabel}
                        {job.durationMs !== undefined ? ` / 耗时 ${(job.durationMs / 1000).toFixed(1)}s` : ""}
                      </small>
                      <div className="job-actions">
                        <button className="mini-action" type="button" onClick={() => setSelectedTaskJobId(selectedTaskJobId === job.id ? null : job.id)}>
                          {selectedTaskJobId === job.id ? "收起日志" : "查看日志"}
                        </button>
                        <button className="mini-action" type="button" onClick={() => cancelTaskJob(job)} disabled={job.status !== "running"}>
                          取消
                        </button>
                        <button className="mini-action" type="button" onClick={() => void retryTaskJob(job)} disabled={!job.retryAction || job.status === "running"}>
                          重试
                        </button>
                      </div>
                      {selectedTaskJobId === job.id && (
                        <div className="job-log">
                          {job.logs.map((log) => (
                            <p key={log.id}><span>{log.time}</span>{log.message}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
            <div className="panel-title">
              <Library size={18} />
              <h2>参数版本</h2>
            </div>
              <div className="template-toolbar">
                <button className="demo-action" type="button" onClick={handleSaveCurrentSnapshot}>
                  <Save size={16} />
                  保存当前版本
                </button>
                <button className="demo-action" type="button" onClick={handleClearTaskSnapshots} disabled={taskSnapshots.length === 0}>
                  <Trash2 size={16} />
                  清空版本
                </button>
                <span>{taskSnapshots.length}/24 个参数快照</span>
              </div>
              {taskSnapshots.length === 0 ? (
                <p className="panel-note">应用工艺模板或生成刀路后，会自动保存参数快照，可在这里回退并重新生成。</p>
              ) : (
                <div className="snapshot-list">
                  {taskSnapshots.map((snapshot) => (
                    <div className="snapshot-card" key={snapshot.id}>
                      <div>
                        <strong>{snapshot.label}</strong>
                        <span>{snapshot.createdAt}</span>
                      </div>
                      <p>{snapshot.detail}</p>
                      <small>
                        刀具 {snapshot.settings.toolDiameter.toFixed(2)}mm / 进给 {snapshot.settings.feedRate.toFixed(0)} / 毛坯 {formatBlankProfile(snapshot.settings)} / X步距 {snapshot.settings.stepoverMm.toFixed(3)}
                      </small>
                      <button className="demo-action snapshot-action" type="button" onClick={() => restoreSnapshot(snapshot)}>
                        回退到此版本
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>历史版本时间线</h2>
              </div>
              {taskEvents.length === 0 ? (
                <p className="panel-note">当前会话还没有任务记录。载入素材、生成模型、修复 Mesh 或生成刀路后会自动记录。</p>
              ) : (
                <div className="task-timeline">
                  {taskEvents.map((event) => (
                    <div className={`task-event ${event.status}`} key={event.id}>
                      <div className="task-event-heading">
                        <strong>{event.title}</strong>
                        <span>{event.timestamp}</span>
                      </div>
                      <p>{event.detail}</p>
                      {event.actionLinks?.length ? (
                        <div className="task-event-actions">
                          {event.actionLinks.map((link) => (
                            <a className={`task-event-action ${link.tone ?? "primary"}`} href={link.href} key={`${event.id}-${link.href}`}>
                              {link.label}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      <small>{event.category.toUpperCase()}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {activeStage === "deployment" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Cloud size={18} />
                <h2>部署模式</h2>
              </div>
              <p className="panel-note">定义 AI Key、客户素材、模型缓存和重计算任务放在哪里，避免把生产密钥或客户素材直接暴露到前端。</p>
              <div className="deployment-mode-grid">
                {(["local-only", "lan-proxy", "cloud-hybrid"] as const).map((mode) => (
                  <button
                    className={deploymentProfile.mode === mode ? "deployment-mode active" : "deployment-mode"}
                    key={mode}
                    type="button"
                    onClick={() => updateDeploymentProfile("mode", mode)}
                  >
                    <strong>{formatDeploymentMode(mode)}</strong>
                    <span>{getDeploymentModeHint(mode)}</span>
                  </button>
                ))}
              </div>
              <label className="select-row">
                <span>API Key 存放</span>
                <select value={deploymentProfile.apiKeyLocation} onChange={(event) => updateDeploymentProfile("apiKeyLocation", event.target.value as DeploymentProfile["apiKeyLocation"])}>
                  <option value="server-env">后端 .env / 环境变量</option>
                  <option value="browser-local">浏览器本地存储</option>
                  <option value="not-configured">暂未配置</option>
                </select>
              </label>
              <label className="select-row">
                <span>素材/模型存储</span>
                <select value={deploymentProfile.assetStorage} onChange={(event) => updateDeploymentProfile("assetStorage", event.target.value as DeploymentProfile["assetStorage"])}>
                  <option value="browser-cache">仅浏览器缓存</option>
                  <option value="lan-server">局域网服务器</option>
                  <option value="cloud-bucket">云端对象存储</option>
                </select>
              </label>
              <label className="select-row">
                <span>重计算位置</span>
                <select value={deploymentProfile.computeTarget} onChange={(event) => updateDeploymentProfile("computeTarget", event.target.value as DeploymentProfile["computeTarget"])}>
                  <option value="browser">当前浏览器</option>
                  <option value="lan-server">局域网服务器</option>
                  <option value="cloud-worker">云端任务节点</option>
                </select>
              </label>
              <label className="toggle-row deployment-toggle">
                <input
                  type="checkbox"
                  checked={deploymentProfile.allowExternalAssetLinks}
                  onChange={(event) => updateDeploymentProfile("allowExternalAssetLinks", event.target.checked)}
                />
                <span>允许加工包包含外部模型下载链接</span>
              </label>
              <button className="primary-action package-action" type="button" onClick={handleSaveDeploymentProfile}>
                <Save size={17} />
                保存部署方案
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <KeyRound size={18} />
                <h2>密钥与路径</h2>
              </div>
              <label className="field-control">
                <span>局域网访问地址</span>
                <input value={deploymentProfile.lanBaseUrl} onChange={(event) => updateDeploymentProfile("lanBaseUrl", event.target.value)} />
              </label>
              <label className="field-control">
                <span>云端 API 地址</span>
                <input value={deploymentProfile.cloudBaseUrl} onChange={(event) => updateDeploymentProfile("cloudBaseUrl", event.target.value)} placeholder="https://api.example.com" />
              </label>
              <label className="field-control">
                <span>Mesh/刀路缓存目录</span>
                <input value={deploymentProfile.meshCachePath} onChange={(event) => updateDeploymentProfile("meshCachePath", event.target.value)} />
              </label>
              <div className={`deployment-readiness ${deploymentReadiness.level}`}>
                <strong>{deploymentReadiness.title}</strong>
                <span>{deploymentReadiness.detail}</span>
              </div>
              <div className="deployment-checklist">
                {deploymentReadiness.checks.map((check) => (
                  <div className={check.status} key={check.label}>
                    <span>{check.label}</span>
                    <strong>{check.value}</strong>
                    <small>{check.detail}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <HardDrive size={18} />
                <h2>落地建议</h2>
              </div>
              <div className="deployment-advice">
                {deploymentReadiness.suggestions.map((suggestion) => (
                  <p key={suggestion}>{suggestion}</p>
                ))}
              </div>
            </section>
          </>
        )}

        {activeStage === "feedback" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Hammer size={18} />
                <h2>实机反馈</h2>
              </div>
              <p className="panel-note">记录空跑、软材料试雕或正式材料结果，把真实耗时、缺陷和照片绑定到当前参数。</p>
              <div className="feedback-outcomes" role="radiogroup" aria-label="实机结果">
                {(["success", "review", "failed"] as const).map((outcome) => (
                  <button
                    className={feedbackDraft.outcome === outcome ? "active" : ""}
                    key={outcome}
                    type="button"
                    onClick={() => setFeedbackDraft((current) => ({ ...current, outcome }))}
                  >
                    {formatFeedbackOutcome(outcome)}
                  </button>
                ))}
              </div>
              <label className="field-control">
                <span>真实耗时 min</span>
                <input
                  min="0"
                  step="0.1"
                  type="number"
                  value={feedbackDraft.actualMinutes}
                  onChange={(event) => setFeedbackDraft((current) => ({ ...current, actualMinutes: event.target.value }))}
                  placeholder={toolpath ? toolpath.estimatedMinutes.toFixed(1) : "待试雕"}
                />
              </label>
              <div className="feedback-issues">
                {feedbackIssueOptions.map((issue) => (
                  <button className={feedbackDraft.issues.includes(issue) ? "active" : ""} key={issue} type="button" onClick={() => toggleFeedbackIssue(issue)}>
                    {issue}
                  </button>
                ))}
              </div>
              <label className="field-control">
                <span>试雕备注</span>
                <textarea
                  value={feedbackDraft.notes}
                  onChange={(event) => setFeedbackDraft((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="例如：顶部欠切轻微，端部保留正常，进给可提高 10%。"
                />
              </label>
              <label className="upload photo-upload">
                <Camera size={18} />
                <span>{feedbackDraft.photoName ? `已选择：${feedbackDraft.photoName}` : "上传试雕照片"}</span>
                <input accept="image/*" type="file" onChange={handleFeedbackPhoto} />
              </label>
              {feedbackDraft.photoUrl && <img className="feedback-photo-preview" src={feedbackDraft.photoUrl} alt="试雕照片预览" />}
              <button className="primary-action package-action" type="button" onClick={handleSaveMachineFeedback}>
                <Save size={17} />
                保存实机反馈
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>反馈统计</h2>
              </div>
              <div className="feedback-summary">
                <span><strong>{machineFeedback.length}</strong> 记录</span>
                <span><strong>{machineFeedback.filter((item) => item.outcome === "success").length}</strong> 成功</span>
                <span><strong>{machineFeedback.filter((item) => item.outcome !== "success").length}</strong> 待优化</span>
                <span><strong>{calculateAverageActualMinutes(machineFeedback)}</strong> 平均耗时</span>
                <span><strong>{costCalibration.sampleCount}</strong> 校正样本</span>
                <span><strong>{costCalibration.sampleCount > 0 ? `${(costCalibration.averageErrorRate * 100).toFixed(1)}%` : "-"}</strong> 估算误差</span>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <Library size={18} />
                <h2>反馈记录</h2>
              </div>
              {machineFeedback.length === 0 ? (
                <p className="panel-note">还没有实机反馈。完成空跑或试雕后，把结果记录在这里，后续可复用成功参数。</p>
              ) : (
                <div className="feedback-list">
                  {machineFeedback.map((feedback) => (
                    <div className={`feedback-card ${feedback.outcome}`} key={feedback.id}>
                      <div>
                        <strong>{formatFeedbackOutcome(feedback.outcome)}</strong>
                        <span>{feedback.createdAt}</span>
                      </div>
                      <p>{feedback.machineName} / {feedback.toolName} / {feedback.materialName}</p>
                      <small>
                        估算 {feedback.estimatedMinutes?.toFixed(1) ?? "-"} min / 实际 {feedback.actualMinutes?.toFixed(1) ?? "-"} min
                        {feedback.issues.length > 0 ? ` / ${feedback.issues.join("、")}` : " / 无缺陷标签"}
                      </small>
                      {feedback.notes && <p>{feedback.notes}</p>}
                      {feedback.photoUrl && <img src={feedback.photoUrl} alt={feedback.photoName ?? "实机反馈照片"} />}
                      <div className="feedback-actions">
                        <button className="demo-action snapshot-action" type="button" onClick={() => restoreFeedbackSettings(feedback)}>
                          复用这组参数
                        </button>
                        <button className="mini-action" type="button" onClick={() => deleteMachineFeedback(feedback)}>
                          删除记录
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <h2>{workbenchTitle}</h2>
            <p>{workbenchHint}</p>
          </div>
          <div className="status-pill">
            <BadgeInfo size={16} />
            <span>{viewingSimulation ? "正在查看刀路模拟结果" : workbenchView === "heatmap" && toolpath ? "正在查看包络误差热力图" : workbenchView === "gcode" && toolpath ? "正在查看合并 G-code" : workbenchView === "report" && toolpath ? "正在查看加工报告摘要" : isOriginalModelSource ? "已加载原始3D模型" : aiMeshUrl ? "已加载 Meshy AI 3D Mesh" : generatedDepth ? (isMultiviewGenerated ? "已生成本地360°环绕浮雕" : "已生成3D浮雕") : images.length > 0 ? "等待点击3D生成" : "未上传图片，显示内置示例"}</span>
          </div>
        </header>

        <div className="workbench-tabs" role="tablist" aria-label="workbench views">
          <button className={workbenchView === "model" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("model"); setIsSimulationMode(false); }}>3D模型</button>
          <button className={workbenchView === "simulation" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("simulation"); setIsSimulationMode(true); }} disabled={!toolpath}>模拟雕刻</button>
          {!V3_TRIAL_FOCUSED_UI && <button className={workbenchView === "heatmap" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("heatmap"); setIsSimulationMode(false); }} disabled={!toolpath}>热力图</button>}
          {!V3_TRIAL_FOCUSED_UI && <button className={workbenchView === "gcode" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("gcode"); setIsSimulationMode(false); }} disabled={!toolpath}>G-code</button>}
          <button className={workbenchView === "report" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("report"); setIsSimulationMode(false); }} disabled={!toolpath}>报告</button>
        </div>

        {workbenchView === "gcode" && toolpath ? (
          <GcodePreview toolpath={toolpath} exportGateReady={exportGateReady} />
        ) : workbenchView === "heatmap" && toolpath && envelopeQuality ? (
          <EnvelopeHeatmapPreview toolpath={toolpath} settings={settings} envelopeQuality={envelopeQuality} heatmapDiagnosis={envelopeHeatmapDiagnosis} />
        ) : workbenchView === "report" && toolpath ? (
          <WorkbenchReportSummary
            exportBlocked={exportBlocked}
            manufacturingQuality={manufacturingQuality}
            materialRemoval={materialRemoval}
            costEstimate={costEstimate}
            envelopeQuality={envelopeQuality}
            safetyIssues={safetyIssues}
          />
        ) : viewingSimulation ? (
          <div className="simulation-view-shell">
            <SimulationViewer
              points={toolpath?.points ?? selectedToolpathPoints}
              previewPoints={toolpath.previewPoints ?? []}
              settings={settings}
              envelopeColor={toolpathColors.simulation}
              surfaceColor={getToolpathSurfaceColor(toolpathKind)}
            />
            <div className="viewer-corner-note">
              <strong>{settings.camMode === "3axis" ? "三轴平面仿真" : settings.camMode === "rotaryWrap" ? "旋转包裹仿真" : "四轴核胚仿真"}</strong>
              <span>{settings.camMode === "3axis" ? "显示 X/Y/Z 平面切削结果" : "显示刀路映射到核胚后的切削包络"}</span>
            </div>
          </div>
        ) : aiMeshUrl ? (
          <AiMeshViewer
            modelUrl={aiMeshUrl}
            modelName={originalModelFileName ?? aiMeshUrl}
            toolpathPoints={selectedToolpathPoints}
            previewPoints={toolpath?.previewPoints ?? []}
            toolpathColor={toolpathColors[toolpathKind]}
            meshLengthAxis={settings.meshLengthAxis}
            meshAxisReverse={settings.meshAxisReverse}
          />
        ) : (
          <ReliefViewer geometry={geometry} wireframe={wireframe} toolpathPoints={selectedToolpathPoints} settings={settings} />
        )}

        <footer className="output-bar">
          {aiMeshUrl ? (
            <>
              <div className="metric">
                <span>模式</span>
                <strong>{isOriginalModelSource ? "原始3D模型" : "Meshy AI Mesh"}</strong>
              </div>
              <div className="metric wide">
                <span>模型</span>
                <strong>{isOriginalModelSource ? originalModelFileName : "GLB/STL真实网格"}</strong>
              </div>
              {toolpath && (
                <div className="metric wide">
                  <span>刀路显示</span>
                  <strong>{getToolpathKindLabel(toolpathKind)}</strong>
                </div>
              )}
              {!V3_TRIAL_FOCUSED_UI && (
                <button className="download" type="button" onClick={() => handleDownloadModelAsset(aiMeshUrl, isOriginalModelSource ? originalModelFileName ?? "original-model.glb" : "ai-mesh.glb")} title="下载当前 GLB 模型文件">
                  <Download size={17} />
                  {isOriginalModelSource ? "下载原始模型" : "下载 GLB"}
                </button>
              )}
              {!V3_TRIAL_FOCUSED_UI && aiMeshStlUrl && (
                <button className="download secondary" type="button" onClick={() => handleDownloadModelAsset(aiMeshStlUrl, isOriginalModelSource ? originalModelFileName ?? "original-model.stl" : "ai-mesh.stl")} title="下载当前 STL 模型文件">
                  <Download size={17} />
                  {isOriginalModelSource ? "下载 STL" : "下载 AI STL"}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="metric">
                <span>网格</span>
                <strong>{settings.meshU} x {settings.meshV}</strong>
              </div>
              <div className="metric">
                <span>最大深度</span>
                <strong>{settings.depthMm.toFixed(2)} mm</strong>
              </div>
              <div className="metric">
                <span>雕刻角</span>
                <strong>{settings.reliefAngleDeg.toFixed(0)}°</strong>
              </div>
            </>
          )}
          {generatedDepth && !aiMeshUrl && (
            <div className="metric">
              <span>模式</span>
              <strong>{isMultiviewGenerated ? "本地环绕浮雕" : "浮雕网格"}</strong>
            </div>
          )}
          {!aiMeshUrl && !V3_TRIAL_FOCUSED_UI && (
            <button className="download secondary" onClick={() => exportGeometryAsStl(geometry, "nuclear-carving-relief.stl")} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
              <Download size={17} />
              下载 STL
            </button>
          )}
          {toolpath && (
            <>
              <div className="metric">
                <span>刀路点</span>
                <strong>{selectedToolpathPoints.length}</strong>
              </div>
              <div className="metric">
                <span>当前程序</span>
                <strong>{getToolpathKindLabel(toolpathKind)}</strong>
              </div>
              <div className="metric">
                <span>估算时间</span>
                <strong>{(selectedToolpathProgram?.estimatedMinutes ?? toolpath.estimatedMinutes).toFixed(1)} min</strong>
              </div>
              {costEstimate && (
                <div className="metric">
                  <span>成本估算</span>
                  <strong>{formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh)}</strong>
                </div>
              )}
              {toolpath.programs?.rough && (
                <div className="metric">
                  <span>粗加工</span>
                  <strong>{toolpath.programs.rough.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              {toolpath.programs?.finish && (
                <div className="metric">
                  <span>精加工</span>
                  <strong>{toolpath.programs.finish.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              {toolpath.programs?.rest && (
                <div className="metric">
                  <span>清残</span>
                  <strong>{toolpath.programs.rest.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              {toolpath.summary.process && (
                <>
                  <div className="metric">
                    <span>清残占比</span>
                    <strong>{toolpath.summary.process.restPointRate.toFixed(1)}%</strong>
                  </div>
                  <div className="metric wide">
                    <span>清残触发</span>
                    <strong>{toolpath.summary.process.restTrigger}</strong>
                  </div>
                </>
              )}
              <div className="metric">
                <span>后处理</span>
                <strong>{toolpath.postProcessorName}</strong>
              </div>
              <div className={`metric ${exportBlocked ? "warning" : "ok"}`}>
                <span>导出校验</span>
                <strong>{exportBlocked ? "存在阻断项" : "可导出"}</strong>
              </div>
              <div className="metric wide">
                <span>范围</span>
                <strong>
                  {formatToolpathRange(toolpath, settings)}
                </strong>
              </div>
              <div className={`metric wide ${toolpath.summary.warnings.length > 0 ? "warning" : "ok"}`}>
                <span>校验</span>
                <strong>{toolpath.summary.warnings[0] ?? "基础范围正常"}</strong>
              </div>
              {envelopeQuality && (
                <>
                  <div className={`metric ${envelopeQuality.score >= 92 ? "ok" : envelopeQuality.score >= 82 ? "" : "warning"}`}>
                    <span>包络评分</span>
                    <strong>{envelopeQuality.score.toFixed(1)} / 100</strong>
                  </div>
                  <div className="metric">
                    <span>贴合率</span>
                    <strong>{envelopeQuality.fitRate.toFixed(1)}%</strong>
                  </div>
                  <div className="metric">
                    <span>未贴合点</span>
                    <strong>{envelopeQuality.missCount}</strong>
                  </div>
                  <div className="metric">
                    <span>连续贴合</span>
                    <strong>{envelopeQuality.continuityRate.toFixed(1)}%</strong>
                  </div>
                </>
              )}
              <div className="metric legend-metric">
                <span>颜色标识</span>
                <strong>
                  <i className={`legend-dot ${viewingSimulation ? "simulation" : toolpathKind}`} />
                  {viewingSimulation
                    ? "青绿=模拟包络，粉色=未贴合"
                    : aiMeshUrl
                      ? `${getToolpathKindColorLabel(toolpathKind)}，粉色=未贴合`
                      : `${getToolpathKindColorLabel(toolpathKind)}，粉色=夹持区，浅琥珀=过渡区`}
                </strong>
              </div>
              {!V3_TRIAL_FOCUSED_UI && (
                <div className="toolpath-program-switch" role="group" aria-label="toolpath program view">
                  <button type="button" className={toolpathKind === "rough" ? "active" : ""} onClick={() => setToolpathKind("rough")} disabled={!toolpath.programs?.rough}>
                    粗加工
                  </button>
                  <button type="button" className={toolpathKind === "finish" ? "active" : ""} onClick={() => setToolpathKind("finish")} disabled={!toolpath.programs?.finish}>
                    精加工
                  </button>
                  <button type="button" className={toolpathKind === "rest" ? "active" : ""} onClick={() => setToolpathKind("rest")} disabled={!toolpath.programs?.rest || toolpath.programs.rest.points.length === 0}>
                    清残
                  </button>
                </div>
              )}
              <button className="download secondary" onClick={() => {
                const nextView: WorkbenchView = viewingSimulation ? "model" : "simulation";
                setWorkbenchView(nextView);
                setIsSimulationMode(nextView === "simulation");
              }}>
                <Layers3 size={17} />
                {viewingSimulation ? "返回3D视图" : "模拟雕刻"}
              </button>
              {V3_TRIAL_FOCUSED_UI ? (
                <>
                  <div className={`v3-output-next ${v3FocusedNextAction.level}`}>
                    <span>下一步</span>
                    <strong>{v3FocusedNextAction.title}</strong>
                    <small>{v3FocusedNextAction.detail}</small>
                  </div>
                  {!v3Job?.result?.summary.deliveryManifest && (
                    <button
                      className="download"
                      onClick={isModelReadyForCam ? handleRunV3OrchestratorLoop : () => setActiveStage("model")}
                      disabled={isV3JobRunning}
                      type="button"
                      title={isModelReadyForCam ? "直接提交 V3 小闭环，生成旋转夹具刀路和安全试雕包" : "先去导入 GLB/STL，或等待模型上传到后端缓存"}
                    >
                      {isModelReadyForCam ? <Cloud size={17} /> : <Box size={17} />}
                      {isV3JobRunning ? "生成中..." : isModelReadyForCam ? "生成试雕刀路与安全包" : "导入3D模型"}
                    </button>
                  )}
                  {v3Job?.result?.summary.deliveryManifest && (
                    <button className="download" onClick={handleDownloadV3TrialPackage} disabled={isV3PackageDownloading} type="button" title="下载只允许空跑和低风险试雕的安全交付包">
                      <Download size={17} />
                      {isV3PackageDownloading ? "打包中..." : "安全试雕包"}
                    </button>
                  )}
                  {v3SafeTrialPlanFile?.url && (
                    <a className="download secondary" href={v3SafeTrialPlanFile.url} download title="下载安全试雕执行计划">
                      <Download size={17} />
                      执行计划
                    </a>
                  )}
                  {v3DownloadChecklistSummary?.checklistUrl && (
                    <a className="download secondary" href={v3DownloadChecklistSummary.checklistUrl} download title="下载操作员核验清单">
                      <Download size={17} />
                      核验清单
                    </a>
                  )}
                </>
              ) : (
                <>
                  <button className="download secondary" onClick={handleDownloadOperatorPackage} disabled={!canDownloadOperatorPackage} title="下载加工参数、模型来源、校验结果和上机说明">
                    <Download size={17} />
                    加工包说明
                  </button>
                  <button className="download secondary" onClick={handleDownloadAirRun} disabled={!canDownloadAirRun} title="主轴关闭，Z 保持安全高度，用于离料空跑验证机器动作">
                    <Download size={17} />
                    下载空跑 NC
                  </button>
                  <button className="download" onClick={() => downloadText("nuclear-carving-toolpath.nc", toolpath.gcode)} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                    <Download size={17} />
                    下载合并 NC
                  </button>
                  {toolpath.programs?.rough && (
                    <button className="download secondary" onClick={() => downloadText(toolpath.programs?.rough?.filename ?? "nuclear-carving-rough.nc", toolpath.programs?.rough?.gcode ?? "")} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                      <Download size={17} />
                      下载粗加工
                    </button>
                  )}
                  {toolpath.programs?.finish && (
                    <button className="download secondary" onClick={() => downloadText(toolpath.programs?.finish?.filename ?? "nuclear-carving-finish.nc", toolpath.programs?.finish?.gcode ?? "")} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                      <Download size={17} />
                      下载精加工
                    </button>
                  )}
                  {toolpath.programs?.rest && (
                    <button className="download secondary" onClick={() => downloadText(toolpath.programs?.rest?.filename ?? "nuclear-carving-rest.nc", toolpath.programs?.rest?.gcode ?? "")} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                      <Download size={17} />
                      下载清残
                    </button>
                  )}
                  <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.tap", toolpath.tap)} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                    <Download size={17} />
                    下载 TAP
                  </button>
                  <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.txt", toolpath.txt)} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                    <Download size={17} />
                    下载 TXT
                  </button>
                  <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.csv", toolpath.csv, "text/csv")} disabled={!formalDownloadAllowed} title={productionDownloadTitle}>
                  <Download size={17} />
                    下载 CSV
                  </button>
                </>
              )}
            </>
          )}
          {!toolpath && (
            <div className="hint">
              <ImagePlus size={17} />
              {aiMeshUrl
                ? "Meshy模型已加载，右侧可拖动查看"
                : images.length > 0 && !generatedDepth
                  ? "先点击左侧“3D生成”"
                  : V3_TRIAL_FOCUSED_UI
                    ? "导入3D模型后在 CAM 面板生成试雕刀路与安全包"
                    : "调好模型后点击左侧“生成刀路”"}
            </div>
          )}
        </footer>
      </section>
    </main>
  );
}

function GcodePreview({ toolpath, exportGateReady }: { toolpath: GeneratedToolpath; exportGateReady: boolean }) {
  const lines = toolpath.gcode.split(/\r?\n/).filter(Boolean);
  const head = lines.slice(0, 18);
  const tail = lines.slice(Math.max(18, lines.length - 18));

  return (
    <div className="workbench-panel">
      <div className="gcode-summary">
        <span><strong>{lines.length.toLocaleString()}</strong> 行 G-code</span>
        <span><strong>{toolpath.summary.xMin.toFixed(1)}~{toolpath.summary.xMax.toFixed(1)}</strong> X 范围</span>
        <span><strong>{toolpath.summary.yMin != null ? `${toolpath.summary.yMin.toFixed(1)}~${toolpath.summary.yMax?.toFixed(1)}` : `${toolpath.summary.aMin.toFixed(0)}~${toolpath.summary.aMax.toFixed(0)}`}</strong> {toolpath.summary.yMin != null ? "Y 范围" : "A 范围"}</span>
        <span><strong>{exportGateReady ? "已解锁" : "待确认"}</strong> 正式导出</span>
      </div>
      <div className="gcode-preview-grid">
        <section>
          <h3>程序开头</h3>
          <pre>{head.join("\n")}</pre>
        </section>
        <section>
          <h3>程序结尾</h3>
          <pre>{tail.join("\n")}</pre>
        </section>
      </div>
    </div>
  );
}

function createTaskJobLog(message: string): TaskJobLog {
  return {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    message
  };
}

function formatTaskJobStatus(status: TaskJob["status"]) {
  if (status === "running") return "运行中";
  if (status === "done") return "完成";
  if (status === "canceled") return "已取消";
  return "失败";
}

function formatFeedbackOutcome(outcome: MachineFeedback["outcome"]) {
  if (outcome === "success") return "试雕成功";
  if (outcome === "review") return "需复核";
  return "失败/断刀";
}

function formatEvidenceItemStatus(status: "pass" | "review" | "block") {
  if (status === "pass") return "通过";
  if (status === "block") return "阻断";
  return "复核";
}

function createProductionCrossCheckTiles(crossChecks: NonNullable<NonNullable<TaskJob["result"]>["summary"]["productionEvidenceDossier"]>["crossChecks"]) {
  if (!crossChecks) return [];
  return [
    {
      label: "CAM交接",
      value: crossChecks.camHandoffReady ? "就绪" : "待复核",
      detail: crossChecks.realMaterialRemovalVerified ? "真实材料去除已绑定" : "仍需真实CAM/材料去除证据",
      level: crossChecks.camHandoffReady && crossChecks.realMaterialRemovalVerified ? "ok" : "warning"
    },
    {
      label: "Neutral源",
      value: crossChecks.neutralSourceBindingPass ? "已绑定" : "未通过",
      detail: `源绑定：${crossChecks.neutralSourceBindingStatus ?? "未知"}`,
      level: crossChecks.neutralSourceBindingPass ? "ok" : "critical"
    },
    {
      label: "CAMotics输入",
      value: crossChecks.camoticsInputIdentityStatus === "matched" ? "匹配" : "不匹配",
      detail: `输入身份：${crossChecks.camoticsInputIdentityStatus ?? "缺失"} / 包绑定：${crossChecks.camoticsCliRunPackageBindingStatus ?? "缺失"}`,
      level: crossChecks.camoticsInputIdentityStatus === "matched" && crossChecks.camoticsCliRunPackageBindingStatus === "bound" ? "ok" : "critical"
    },
    {
      label: "CAMotics运动",
      value: crossChecks.camoticsMotionConsistencyStatus === "matched" ? "一致" : "待确认",
      detail: `运动一致性：${crossChecks.camoticsMotionConsistencyStatus ?? "缺失"}`,
      level: crossChecks.camoticsMotionConsistencyStatus === "matched" ? "ok" : "critical"
    },
    {
      label: "仿真产物",
      value: crossChecks.camoticsArtifactEvidenceStatus === "complete" ? "完整" : "不完整",
      detail: `产物证据：${crossChecks.camoticsArtifactEvidenceStatus ?? "缺失"}`,
      level: crossChecks.camoticsArtifactEvidenceStatus === "complete" ? "ok" : "critical"
    },
    {
      label: "NC静态",
      value: crossChecks.ncStaticReady && crossChecks.controllerDialectReady ? "通过" : "待复核",
      detail: `静态检查 ${crossChecks.ncStaticReady ? "通过" : "未通过"} / 控制器方言 ${crossChecks.controllerDialectReady ? "匹配" : "待确认"}`,
      level: crossChecks.ncStaticReady && crossChecks.controllerDialectReady ? "ok" : "warning"
    },
    {
      label: "机床验收",
      value: crossChecks.machineAcceptancePassed && crossChecks.machineAcceptanceIntegrityBound ? "通过" : "未解锁",
      detail: `记录 ${crossChecks.machineAcceptanceRecords ?? 0} / 最新 ${crossChecks.latestMachineAcceptanceOutcome ?? "无"} / 完整性 ${crossChecks.machineAcceptanceIntegrityBound ? "已绑定" : "未绑定"}`,
      level: crossChecks.machineAcceptancePassed && crossChecks.machineAcceptanceIntegrityBound ? "ok" : "critical"
    },
    {
      label: "试雕反馈",
      value: `${crossChecks.trialFeedbackRecords ?? 0} 条`,
      detail: `优化状态：${crossChecks.optimizationStatus ?? "未生成"}`,
      level: (crossChecks.trialFeedbackRecords ?? 0) > 0 ? "ok" : "warning"
    }
  ];
}

function createProductionCrossCheckReadmeLines(crossChecks: NonNullable<NonNullable<TaskJob["result"]>["summary"]["productionEvidenceDossier"]>["crossChecks"]) {
  const tiles = createProductionCrossCheckTiles(crossChecks);
  if (tiles.length === 0) {
    return [
      "- CAM交接: 未生成交叉校验，不能作为生产放行证据。",
      "- CAMotics输入: 未生成输入身份校验，真实材料去除结果不可绑定当前NC。",
      "- 机床验收: 未生成验收绑定，禁止直接上机生产。"
    ];
  }
  return tiles.map((item) => `- ${item.label}: ${item.value} / ${item.detail}`);
}

function calculateAverageActualMinutes(feedback: MachineFeedback[]) {
  const values = feedback.map((item) => item.actualMinutes).filter((value): value is number => typeof value === "number" && value > 0);
  if (values.length === 0) return "-";
  return `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)} min`;
}

function createCostCalibrationReport(
  costEstimate: CostEstimate | null,
  feedback: MachineFeedback[],
  machineName: string,
  toolName: string
): CostCalibrationReport {
  const empty: CostCalibrationReport = {
    sampleCount: 0,
    averageRatio: 1,
    averageErrorRate: 0,
    calibratedTotalMinutes: costEstimate?.totalMinutes ?? 0,
    calibratedCostLow: costEstimate?.totalCostLow ?? 0,
    calibratedCostHigh: costEstimate?.totalCostHigh ?? 0,
    confidence: "none",
    matchedSamples: []
  };
  if (!costEstimate) return empty;

  const usable = feedback.filter((item) => item.actualMinutes && item.actualMinutes > 0 && item.estimatedMinutes && item.estimatedMinutes > 0);
  const matched = usable.filter((item) => item.machineName === machineName && item.toolName === toolName);
  const samples = (matched.length >= 2 ? matched : usable).slice(0, 12);
  if (samples.length === 0) return empty;

  const ratios = samples.map((item) => (item.actualMinutes ?? 0) / Math.max(1, item.estimatedMinutes ?? 1));
  const averageRatio = THREEClamp(ratios.reduce((sum, value) => sum + value, 0) / ratios.length, 0.45, 2.4);
  const averageErrorRate = samples.reduce((sum, item) => {
    const estimated = Math.max(1, item.estimatedMinutes ?? 1);
    return sum + Math.abs((item.actualMinutes ?? estimated) - estimated) / estimated;
  }, 0) / samples.length;
  const calibratedTotalMinutes = costEstimate.totalMinutes * averageRatio;
  const timeRatio = calibratedTotalMinutes / Math.max(1, costEstimate.totalMinutes);
  const calibratedCostLow = costEstimate.totalCostLow * timeRatio;
  const calibratedCostHigh = costEstimate.totalCostHigh * timeRatio;
  const confidence: CostCalibrationReport["confidence"] = samples.length >= 6 ? "high" : samples.length >= 3 ? "medium" : "low";

  return {
    sampleCount: samples.length,
    averageRatio,
    averageErrorRate,
    calibratedTotalMinutes,
    calibratedCostLow,
    calibratedCostHigh,
    confidence,
    matchedSamples: samples
  };
}

function formatCalibrationConfidence(confidence: CostCalibrationReport["confidence"]) {
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  if (confidence === "low") return "低";
  return "无样本";
}

function formatUserRole(role: UserRole) {
  if (role === "admin") return "管理员";
  if (role === "designer") return "设计员";
  if (role === "process") return "工艺员";
  return "操作员";
}

function getRolePermissionText(role: UserRole) {
  if (role === "operator") return "仅允许下载已通过安全校验并完成正式导出确认的文件；适合交给机台操作员。";
  if (role === "designer") return "可整理素材、生成模型和查看预览；正式导出仍需工艺/管理确认。";
  if (role === "process") return "可调整工艺、生成刀路、仿真并完成导出前确认。";
  return "拥有完整项目、工艺、导出和反馈管理权限。";
}

function formatToolpathRange(toolpath: GeneratedToolpath, settings: ModelSettings) {
  if (settings.camMode === "rotaryWrap") {
    const axis = settings.rotaryOutputAxis ?? "Y";
    const min = (toolpath.summary.aMin / 360) * Math.max(0.001, settings.rotaryWrapPerRevolutionMm ?? 100);
    const max = (toolpath.summary.aMax / 360) * Math.max(0.001, settings.rotaryWrapPerRevolutionMm ?? 100);
    return `X ${toolpath.summary.xMin.toFixed(1)}~${toolpath.summary.xMax.toFixed(1)} / ${axis} ${axis === "A" ? `${toolpath.summary.aMin.toFixed(0)}~${toolpath.summary.aMax.toFixed(0)}deg` : `${min.toFixed(1)}~${max.toFixed(1)}mm`} / Z ${toolpath.summary.zMin.toFixed(1)}~${toolpath.summary.zMax.toFixed(1)}`;
  }

  if (settings.camMode === "3axis" || toolpath.summary.yMin != null) {
    return `X ${toolpath.summary.xMin.toFixed(1)}~${toolpath.summary.xMax.toFixed(1)} / Y ${(toolpath.summary.yMin ?? 0).toFixed(1)}~${(toolpath.summary.yMax ?? 0).toFixed(1)} / Z ${toolpath.summary.zMin.toFixed(1)}~${toolpath.summary.zMax.toFixed(1)}`;
  }

  return `X ${toolpath.summary.xMin.toFixed(1)}~${toolpath.summary.xMax.toFixed(1)} / A ${toolpath.summary.aMin.toFixed(0)}~${toolpath.summary.aMax.toFixed(0)}`;
}

function readImportedRotaryWrapSettings(source: string): { axis: ModelSettings["rotaryOutputAxis"]; perRevMm: number } | null {
  const axisMatch = source.match(/ROTARY_WRAP_AXIS\s*=\s*([AXY])/i);
  if (!axisMatch) return null;
  const perRevMatch = source.match(/ROTARY_WRAP_PER_REV_MM\s*=\s*([-+]?\d*\.?\d+)/i);
  return {
    axis: axisMatch[1].toUpperCase() as ModelSettings["rotaryOutputAxis"],
    perRevMm: Math.max(0.001, Number(perRevMatch?.[1] ?? 100))
  };
}

function normalizeSettings(settings: ModelSettings): ModelSettings {
  const left = settings.blankLeftDiameterMm;
  const center = settings.blankCenterDiameterMm;
  const right = settings.blankRightDiameterMm;
  return {
    ...settings,
    camMode: settings.camMode ?? "4axis",
    rotaryOutputAxis: settings.rotaryOutputAxis ?? "A",
    rotaryWrapPerRevolutionMm: Number.isFinite(settings.rotaryWrapPerRevolutionMm) ? settings.rotaryWrapPerRevolutionMm : 100,
    postProcessor: settings.postProcessor ?? "generic",
    blankLeftMidDiameterMm: Number.isFinite(settings.blankLeftMidDiameterMm) ? settings.blankLeftMidDiameterMm : (left + center) / 2,
    blankRightMidDiameterMm: Number.isFinite(settings.blankRightMidDiameterMm) ? settings.blankRightMidDiameterMm : (right + center) / 2
  };
}

function getBlankProfileDiameters(settings: ModelSettings) {
  const normalized = normalizeSettings(settings);
  return [
    normalized.blankLeftDiameterMm,
    normalized.blankLeftMidDiameterMm,
    normalized.blankCenterDiameterMm,
    normalized.blankRightMidDiameterMm,
    normalized.blankRightDiameterMm
  ];
}

function formatBlankProfile(settings: ModelSettings) {
  return getBlankProfileDiameters(settings).map((diameter) => diameter.toFixed(1)).join("-");
}

function roundBlankProfile(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    blankLeftDiameterMm: roundToTenth(settings.blankLeftDiameterMm),
    blankLeftMidDiameterMm: roundToTenth(settings.blankLeftMidDiameterMm),
    blankCenterDiameterMm: roundToTenth(settings.blankCenterDiameterMm),
    blankRightMidDiameterMm: roundToTenth(settings.blankRightMidDiameterMm),
    blankRightDiameterMm: roundToTenth(settings.blankRightDiameterMm)
  };
}

function roundToTenth(value: number) {
  return Math.round(value * 10) / 10;
}

function formatBlankTemplate(template: "standard" | "tapered" | "offset") {
  if (template === "standard") return "标准核胚";
  if (template === "tapered") return "两端收尖";
  return "偏心核胚";
}

function createDefaultMachineAcceptanceRecord(machine: MachineProfile): MachineAcceptanceRecord {
  return {
    machineId: machine.id,
    machineName: machine.name,
    controller: machine.controller,
    updatedAt: "",
    airRun: false,
    airRunAt: null,
    softTrial: false,
    softTrialAt: null,
    formalTrial: false,
    formalTrialAt: null,
    notes: ""
  };
}

function getMachineAcceptanceRecord(records: MachineAcceptanceRecord[], machine: MachineProfile) {
  const found = records.find((record) => record.machineId === machine.id);
  return found ? { ...createDefaultMachineAcceptanceRecord(machine), ...found, machineName: machine.name, controller: machine.controller } : createDefaultMachineAcceptanceRecord(machine);
}

function formatMachineAcceptanceStep(step: MachineAcceptanceStep) {
  if (step === "airRun") return "离料空跑";
  if (step === "softTrial") return "软材料试雕";
  return "正式材料试雕";
}

function getMachineAcceptanceStepTime(record: MachineAcceptanceRecord, step: MachineAcceptanceStep) {
  if (step === "airRun") return record.airRunAt;
  if (step === "softTrial") return record.softTrialAt;
  return record.formalTrialAt;
}

function createMachineAcceptanceStatus(record: MachineAcceptanceRecord) {
  const passedCount = [record.airRun, record.softTrial, record.formalTrial].filter(Boolean).length;
  const level: "ok" | "warning" | "critical" = record.airRun ? (record.softTrial ? "ok" : "warning") : "critical";
  return {
    level,
    title: record.airRun
      ? record.softTrial
        ? record.formalTrial
          ? "该机床已完成完整验收"
          : "该机床已完成试雕验收"
        : "该机床仅完成空跑验收"
      : "该机床尚未记录空跑验收",
    detail: record.airRun
      ? `已完成 ${passedCount}/3 项；${record.updatedAt ? `最近更新 ${record.updatedAt}` : "建议在正式下载前补充软材料试雕记录。"}`
      : "首次使用当前机床或后处理器时，请先下载空跑程序并在离料状态验证 X/Z/A 方向、限位和夹具距离。"
  };
}

function formatDeploymentMode(mode: DeploymentMode) {
  if (mode === "local-only") return "纯本地单机";
  if (mode === "lan-proxy") return "店内局域网";
  return "云端混合";
}

function getDeploymentModeHint(mode: DeploymentMode) {
  if (mode === "local-only") return "适合离线演示和轻量试算，AI Key 不应放前端。";
  if (mode === "lan-proxy") return "推荐门店首版，前端访问局域网后端代理。";
  return "适合多门店协作，重计算和素材归档走云端。";
}

function formatApiKeyLocation(location: DeploymentProfile["apiKeyLocation"]) {
  if (location === "server-env") return "后端环境变量";
  if (location === "browser-local") return "浏览器本地";
  return "暂未配置";
}

function formatAssetStorage(storage: DeploymentProfile["assetStorage"]) {
  if (storage === "browser-cache") return "浏览器缓存";
  if (storage === "lan-server") return "局域网服务器";
  return "云端对象存储";
}

function formatComputeTarget(target: DeploymentProfile["computeTarget"]) {
  if (target === "browser") return "当前浏览器";
  if (target === "lan-server") return "局域网服务器";
  return "云端任务节点";
}

function createDeploymentReadiness(profile: DeploymentProfile) {
  const checks = [
    {
      label: "API Key",
      value: formatApiKeyLocation(profile.apiKeyLocation),
      status: profile.apiKeyLocation === "server-env" ? "ok" : profile.apiKeyLocation === "not-configured" ? "critical" : "warning",
      detail: profile.apiKeyLocation === "server-env"
        ? "Meshy 等密钥由后端代理读取，前端和加工包不暴露密钥。"
        : profile.apiKeyLocation === "browser-local"
          ? "浏览器本地存储适合临时测试，不建议用于客户素材生产。"
          : "AI 生成、修复和云端重计算会不可用。"
    },
    {
      label: "素材存储",
      value: formatAssetStorage(profile.assetStorage),
      status: profile.assetStorage === "browser-cache" && profile.mode !== "local-only" ? "warning" : "ok",
      detail: profile.assetStorage === "browser-cache"
        ? "刷新或换电脑后素材追溯能力较弱。"
        : "素材和生成模型可以随项目归档，便于复盘。"
    },
    {
      label: "重计算",
      value: formatComputeTarget(profile.computeTarget),
      status: profile.computeTarget === "browser" && profile.mode !== "local-only" ? "warning" : "ok",
      detail: profile.computeTarget === "browser"
        ? "高精度仿真和批量任务可能卡住页面。"
        : "长任务可进入后端队列，适合 Mesh 修复、CAM 和仿真。"
    },
    {
      label: "访问地址",
      value: profile.mode === "cloud-hybrid" ? profile.cloudBaseUrl || "未填写" : profile.lanBaseUrl || "未填写",
      status: (profile.mode === "cloud-hybrid" ? profile.cloudBaseUrl : profile.lanBaseUrl) ? "ok" : "critical",
      detail: profile.mode === "local-only" ? "单机可直接访问本机服务。" : "操作员电脑需要能稳定访问该地址。"
    }
  ] as Array<{ label: string; value: string; status: "ok" | "warning" | "critical"; detail: string }>;

  const criticalCount = checks.filter((check) => check.status === "critical").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const suggestions: string[] = [];
  if (profile.apiKeyLocation !== "server-env") suggestions.push("生产环境建议把 Meshy Key 放在后端 `.env`，前端只调用 `/api/*` 代理接口。");
  if (profile.mode === "lan-proxy") suggestions.push("门店首版推荐一台 Linux/Windows 小服务器运行前端和 API 代理，操作员通过局域网访问。");
  if (profile.mode === "cloud-hybrid") suggestions.push("云端混合需要对象存储、任务队列和访问审计；客户素材应按项目隔离。");
  if (profile.computeTarget === "browser") suggestions.push("高精度材料去除仿真、Mesh 修复和批量 CAM 建议迁移到后端任务队列。");
  if (!profile.allowExternalAssetLinks) suggestions.push("加工包默认不放外部模型链接，适合保护客户素材；需要跨设备复核时可临时开启。");
  if (suggestions.length === 0) suggestions.push("当前部署策略满足生产试用基线，可继续做局域网联调和权限审计。");

  return {
    level: criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok",
    title: criticalCount > 0 ? "部署方案存在阻断项" : warningCount > 0 ? "部署方案可试用但需复核" : "部署方案适合生产试用",
    detail: criticalCount > 0
      ? "请先补齐 API Key、访问地址或存储策略，再交给店内多人使用。"
      : warningCount > 0
        ? "可以继续本机测试，但正式处理客户素材前建议迁移到后端代理和可归档存储。"
        : "密钥、素材、任务和访问地址均有明确归属。",
    checks,
    suggestions
  };
}

function formatExternalCamEngineLabel(engineId: string) {
  if (engineId === "freecad") return "FreeCAD";
  if (engineId === "blendercam") return "BlenderCAM";
  if (engineId === "opencamlib") return "OpenCAMLib";
  return engineId;
}

function formatHandoffClassification(classification: string) {
  if (classification === "production-candidate") return "生产候选";
  if (classification === "fixture-contract") return "Fixture测试";
  if (classification === "synthetic-contract") return "Synthetic测试";
  if (/preview|scaffold/i.test(classification)) return "预览脚手架";
  if (classification === "missing-contact-report") return "缺接触报告";
  if (classification === "contact-report-review") return "接触报告待复核";
  if (classification === "missing-cam-proof") return "缺CAM证明";
  if (classification === "cam-proof-review") return "CAM证明待复核";
  if (classification === "not-generated") return "未生成";
  if (classification === "missing") return "缺少证据";
  return classification;
}

function formatExternalCamHandoff(handoff?: V3ExternalHandoffSummary) {
  if (!handoff) return "未验证";
  const status = handoff.status === "completed" && handoff.simulationStatus === "completed"
    ? "completed"
    : `${handoff.status}/${handoff.simulationStatus ?? "no-sim"}`;
  const simulation = handoff.simulationEngine ? ` · ${handoff.simulationEngine}` : "";
  const synthetic = handoff.syntheticSimulation ? " · synthetic" : "";
  const points = handoff.points ? ` · ${handoff.points}点` : "";
  return `${status}${simulation}${synthetic}${points}`;
}

function formatReadinessCamoticsSource(source: string) {
  if (source === "latest-job-evidence-dossier") return "当前Job证据档案";
  if (source === "camotics-import-contract") return "全局导入契约";
  if (source === "missing") return "缺失";
  return source;
}

function formatRunbookLinuxEvidenceStatus(status?: string) {
  if (status === "ready-for-review") return "已随ZIP回填";
  if (status === "missing-zip") return "缺少结果ZIP";
  if (status === "incomplete") return "证据不完整";
  return status ?? "未生成";
}

function formatLinuxOpenCamLibEvidence(openCamLib: NonNullable<NonNullable<NonNullable<V3Readiness["runbookResult"]>["linuxEvidence"]>["evidenceChain"]>["openCamLib"]) {
  const candidate = openCamLib?.realCandidateReady ? "真实候选 ready" : openCamLib?.realCandidateKnown ? "真实候选待复核" : "真实候选缺失";
  const coverageStatus = openCamLib?.contactPathCoverage?.status ?? "missing";
  const coverage = `覆盖率 ${formatOpenCamLibCoverageStatus(coverageStatus)}`;
  const protectedZonesStatus = openCamLib?.protectedZones?.status ?? "missing";
  const protectedZones = `端部保护 ${formatOpenCamLibProtectedZonesStatus(protectedZonesStatus)}`;
  const packageLevel = openCamLib?.candidatePackageLevel ?? "missing";
  const packageStatus = `候选包 ${packageLevel}${openCamLib?.candidatePackageReadyForImport ? "/可导入" : ""}`;
  const packageStep = openCamLib?.candidatePackageStep ?? openCamLib?.candidatePackage?.status ?? "";
  const packageStepStatus = packageStep ? `预检 ${formatLinuxEvidenceStepStatus(packageStep)}` : "";
  const packageFile = openCamLib?.candidatePackage?.exists ? "证据JSON已回填" : "";
  const machineFit = formatLinuxOpenCamLibMachineFit(openCamLib?.candidateMachineFit);
  const blocker = openCamLib?.candidatePackageBlockedReason || openCamLib?.firstBlocking;
  return [candidate, coverage, protectedZones, machineFit, packageStatus, packageStepStatus, packageFile, blocker ? `阻断 ${blocker}` : ""].filter(Boolean).join(" · ");
}

function formatLinuxOpenCamLibMachineFit(machineFit: NonNullable<NonNullable<NonNullable<NonNullable<V3Readiness["runbookResult"]>["linuxEvidence"]>["evidenceChain"]>["openCamLib"]>["candidateMachineFit"]) {
  if (!machineFit) return "";
  const level = machineFit.level ?? "missing";
  const rotarySpan = Number.isFinite(Number(machineFit.coverage?.rotarySpanDeg))
    ? `${Number(machineFit.coverage?.rotarySpanDeg).toFixed(0)}°`
    : "未知角度";
  const target = Number.isFinite(Number(machineFit.coverage?.expectedRotaryCoverageDeg))
    ? `/${Number(machineFit.coverage?.expectedRotaryCoverageDeg).toFixed(0)}°`
    : "";
  const risks = machineFit.riskCounts
    ? [
        machineFit.riskCounts.holdZonePointCount ? `端部${machineFit.riskCounts.holdZonePointCount}` : "",
        machineFit.riskCounts.deepPointCount ? `超深${machineFit.riskCounts.deepPointCount}` : "",
        machineFit.riskCounts.missingRotaryCount ? `缺旋转${machineFit.riskCounts.missingRotaryCount}` : ""
      ].filter(Boolean).join("/")
    : "";
  return `机床适配 ${level} · 旋转${rotarySpan}${target}${risks ? ` · 风险${risks}` : ""}`;
}

function formatLinuxCamoticsUpstreamEvidence(camotics: NonNullable<NonNullable<NonNullable<V3Readiness["runbookResult"]>["linuxEvidence"]>["evidenceChain"]>["camotics"]) {
  const evidence = camotics?.upstreamEvidence;
  const status = evidence?.status ?? camotics?.upstreamEvidenceStatus ?? "missing";
  const statusText = status === "matched" ? "已绑定" : status === "not-required" ? "未要求" : status === "mismatch" ? "不匹配" : status === "missing" ? "缺失" : status;
  const matched = `${evidence?.matchedCount ?? 0}/${evidence?.expectedCount ?? 0}`;
  const candidateValidation = evidence?.candidatePackageValidationBound ? "候选包预检已绑定" : "候选包预检未绑定";
  const candidateBundle = evidence?.candidatePackageBundleBound ? "候选包证据包已绑定" : "候选包证据包未绑定";
  const mismatches = evidence?.mismatchCount ? `不匹配 ${evidence.mismatchCount}` : "";
  return [statusText, `哈希 ${matched}`, candidateValidation, candidateBundle, mismatches].filter(Boolean).join(" · ");
}

function formatLockedProductionPackageGuidance(data: any) {
  const guidance = data?.operatorGuidance;
  const safeTrial = guidance?.safeTrialPackageUrl ? "先下载安全试雕包" : "先生成并下载安全试雕包";
  const evidenceReview = guidance?.evidenceReviewPackageUrl ? "可下载证据审查包复核缺口" : "";
  const readFirst = Array.isArray(guidance?.readFirstFiles) && guidance.readFirstFiles.length
    ? `必读 ${guidance.readFirstFiles.slice(0, 4).join("、")}`
    : "必读 operator-download-checklist.md、machining-package-index.json、production-evidence-dossier.json";
  const neverRun = Array.isArray(guidance?.neverRunOnMachine) && guidance.neverRunOnMachine.length
    ? `禁止上机 ${guidance.neverRunOnMachine.slice(0, 4).map((file: any) => file.filename).filter(Boolean).join("、")}`
    : "禁止把 camotics-preview.nc 或报告文件上机";
  const gap = Array.isArray(guidance?.evidenceGaps) && guidance.evidenceGaps[0]
    ? `证据缺口 ${guidance.evidenceGaps[0].label ?? guidance.evidenceGaps[0].id}: ${guidance.evidenceGaps[0].summary ?? guidance.evidenceGaps[0].status}`
    : data?.summary ?? data?.error ?? "生产证据尚未闭环";
  return [safeTrial, evidenceReview, readFirst, neverRun, gap].filter(Boolean).join("；");
}

function createLockedProductionPackageTaskLinks(data: any) {
  const guidance = data?.operatorGuidance;
  const links: Array<{ label: string; href: string; tone?: "primary" | "warning" }> = [];
  if (guidance?.safeTrialPackageUrl) {
    links.push({ label: "下载安全试雕包", href: guidance.safeTrialPackageUrl, tone: "primary" });
  }
  if (guidance?.evidenceReviewPackageUrl) {
    links.push({ label: "下载证据审查包", href: guidance.evidenceReviewPackageUrl, tone: "primary" });
  }
  if (guidance?.productionPackageUrl) {
    links.push({ label: "重新检查生产包门禁", href: guidance.productionPackageUrl, tone: "warning" });
  }
  return links;
}

function formatLinuxEvidenceStepStatus(status?: string) {
  if (status === "pass") return "通过";
  if (status === "fail") return "失败";
  if (status === "missing") return "缺失";
  if (status === "missing-input") return "缺输入";
  return status ?? "未知";
}

function formatOpenCamLibCoverageStatus(status?: string) {
  if (status === "ready") return "达标";
  if (status === "review") return "待复核";
  if (status === "missing") return "缺失";
  if (status === "not-required") return "暂不要求";
  return status ?? "未知";
}

function formatOpenCamLibProtectedZonesStatus(status?: string) {
  if (status === "ready") return "达标";
  if (status === "review") return "待复核";
  if (status === "missing") return "缺失";
  if (status === "not-required") return "暂不要求";
  return status ?? "未知";
}

function findV3DeliveryFile(job: V3OrchestratorJob | null, filename: string) {
  return job?.result?.summary.deliveryManifest?.files.find((file) => file.filename === filename) ?? null;
}

function createV3DownloadIntegrityEvidence(job: V3OrchestratorJob) {
  const files = job.result?.summary.packageIntegrity?.files ?? [];
  const keyFiles = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc", "camotics-preview.nc"];
  return {
    packageIntegrityReviewed: true,
    operatorChecklistReviewed: true,
    neverMachineConfirmed: true,
    files: keyFiles.map((filename) => {
      const file = files.find((item) => item.filename === filename);
      return {
        filename,
        sha256: file?.sha256 ?? null,
        verified: Boolean(file?.sha256),
        machineUseClass: file?.machineUse?.class ?? null,
        note: file?.exists === false ? "文件缺失，需重新生成加工包。" : undefined
      };
    })
  };
}

function createV3DownloadChecklistSummary(job: V3OrchestratorJob | null) {
  const integrityFiles = job?.result?.summary.packageIntegrity?.files ?? [];
  if (integrityFiles.length === 0) return null;
  const deliveryFiles = job?.result?.summary.deliveryManifest?.files ?? [];
  const byName = new Map(integrityFiles.map((file) => [file.filename, file]));
  const deliveryByName = new Map(deliveryFiles.map((file) => [file.filename, file]));
  const keyFileNames = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc", "camotics-preview.nc"];
  const keyFiles = keyFileNames.map((filename) => {
    const file = byName.get(filename);
    const delivery = deliveryByName.get(filename);
    const machineUse = file?.machineUse ?? delivery?.machineUse;
    return {
      filename,
      url: delivery?.url ?? null,
      sha256: file?.sha256 ?? null,
      verified: Boolean(file?.sha256 && file.exists),
      downloadable: Boolean(delivery?.downloadable),
      allowedOnMachine: Boolean(machineUse?.allowedOnMachine),
      requiresGate: Boolean(machineUse?.requiresGate),
      spindleExpected: Boolean(machineUse?.spindleExpected),
      machineUseClass: machineUse?.class ?? "unknown",
      summary: machineUse?.summary ?? delivery?.note ?? "未生成用途说明。"
    };
  });
  return {
    keyFiles,
    verifiedKeyCount: keyFiles.filter((file) => file.verified).length,
    neverMachineCount: keyFiles.filter((file) => !file.allowedOnMachine).length,
    checklistUrl: deliveryByName.get("operator-download-checklist.md")?.url ?? null,
    closedLoopHandoffUrl: deliveryByName.get("linux-cam-closed-loop-handoff.md")?.url ?? null,
    camHandoffEvidenceUrl: deliveryByName.get("cam-handoff-evidence.md")?.url ?? null
  };
}

function createV3TrialWorkflowSummary({
  hasModel,
  job,
  checklist,
  acceptance
}: {
  hasModel: boolean;
  job: V3OrchestratorJob | null;
  checklist: ReturnType<typeof createV3DownloadChecklistSummary>;
  acceptance: MachineAcceptanceRecord;
}) {
  const jobCompleted = job?.status === "completed" && Boolean(job.result);
  const manifest = job?.result?.summary.deliveryManifest;
  const allowTrial = Boolean(manifest?.allowTrialNc);
  const allowAirRun = Boolean(manifest?.allowAirRun);
  const keyFilesReady = Boolean(checklist && checklist.verifiedKeyCount === checklist.keyFiles.length);
  const trialLog = job?.result?.summary.trialFeedbackLog;
  const feedbackBound = trialLog?.latestDownloadIntegrityBound === "matched";
  const feedbackOk = trialLog?.latestOutcome === "success" && feedbackBound;
  const acceptanceLog = job?.result?.summary.machineAcceptanceLog;
  const acceptanceOk = Boolean(acceptanceLog?.allRequiredPassed);
  const localAcceptanceReady = acceptance.airRun && acceptance.softTrial;
  const steps: V3TrialWorkflowStep[] = [
    {
      id: "model",
      title: "1. 导入 3D 佛头模型",
      status: hasModel ? "done" : "active",
      detail: hasModel ? "模型已缓存为后端可读取文件，可进入 Orchestrator 小闭环。" : "先用 Meshy 生成或直接导入 GLB/STL，避免继续使用二维浮雕代替真实 3D。"
    },
    {
      id: "orchestrator",
      title: "2. 生成试雕刀路与安全包",
      status: !hasModel ? "locked" : jobCompleted ? "done" : "active",
      detail: jobCompleted
        ? `任务 ${job?.id.slice(0, 8)} 已完成，包级别 ${job?.result?.summary.productionGate?.level ?? "trial-only"}。`
        : hasModel
          ? "提交后端队列，生成模型体检、修复计划、Y轴旋转后处理、空跑和安全试雕包。"
          : "等待模型加载。"
    },
    {
      id: "download",
      title: "3. 下载并核验试雕包",
      status: !jobCompleted ? "locked" : keyFilesReady && (allowTrial || allowAirRun) ? "done" : "active",
      detail: keyFilesReady
        ? `关键文件 ${checklist?.verifiedKeyCount ?? 0}/${checklist?.keyFiles.length ?? 0} 已记录 SHA-256；${allowTrial ? "包含候选试雕 NC" : "当前仅允许空跑和报告"}。`
        : jobCompleted
          ? "下载安全试雕包后，按 operator-download-checklist.md 核验 SHA-256 和文件用途。"
          : "等待 Orchestrator 生成交付清单。"
    },
    {
      id: "acceptance",
      title: "4. 空跑/软料试雕并回填",
      status: !jobCompleted ? "locked" : feedbackOk && acceptanceOk ? "done" : localAcceptanceReady || trialLog ? "review" : "active",
      detail: feedbackOk && acceptanceOk
        ? "试雕反馈和机床验收均已绑定当前下载包，可作为后续生产解锁证据。"
        : trialLog && !feedbackBound
          ? "已有试雕反馈，但未绑定当前下载包哈希，需要重新按本包回填。"
          : localAcceptanceReady
            ? "本地已记录空跑/软料试雕，建议同步到 V3 证据链。"
            : "先做旋转标定空跑、整条离料空跑，再用软材料或废料试雕。"
    }
  ];
  const activeStep = steps.find((step) => step.status === "active" || step.status === "review") ?? steps[steps.length - 1];
  const lockedCount = steps.filter((step) => step.status === "locked").length;
  const doneCount = steps.filter((step) => step.status === "done").length;
  return {
    level: lockedCount > 0 ? "critical" : doneCount === steps.length ? "ok" : "warning",
    doneCount,
    total: steps.length,
    activeStep,
    summary: doneCount === steps.length
      ? "安全试雕闭环已完成，生产 NC 仍需真实 CAM/CAMotics/机床验收总门禁放行。"
      : activeStep.detail,
    steps
  };
}

function createV3FocusedNextAction(
  activeStepId: V3TrialWorkflowStep["id"],
  hasModel: boolean,
  hasDeliveryManifest: boolean,
  isRunning: boolean
) {
  if (isRunning) {
    return {
      level: "running",
      title: "正在生成试雕刀路与安全包",
      detail: "完成后右侧会自动切到模拟雕刻，并可下载安全试雕包。"
    };
  }
  if (!hasModel || activeStepId === "model") {
    return {
      level: "critical",
      title: "先导入真实3D模型",
      detail: "支持 GLB/STL/OBJ，或用 Meshy 多图生成 Mesh。"
    };
  }
  if (!hasDeliveryManifest || activeStepId === "orchestrator") {
    return {
      level: "warning",
      title: "生成旋转夹具试雕数据",
      detail: "输出标定空跑、整条空跑、候选试雕 NC、报告和核验清单。"
    };
  }
  if (activeStepId === "download") {
    return {
      level: "ok",
      title: "下载安全试雕包",
      detail: "先按清单核验哈希，再做旋转标定和离料空跑。"
    };
  }
  return {
    level: "ok",
    title: "记录空跑/试雕反馈",
    detail: "把真实机床结果回填到证据链，后续才能逐步解锁生产。"
  };
}

function createV3EvidenceLoopSummary(
  job: V3OrchestratorJob | null,
  downloadChecklist: ReturnType<typeof createV3DownloadChecklistSummary>,
  machineAcceptance: MachineAcceptanceRecord
): V3EvidenceLoopSummary | null {
  if (!job?.result) return null;

  const summary = job.result.summary;
  const verifiedKeyCount = downloadChecklist?.verifiedKeyCount ?? 0;
  const keyFileCount = downloadChecklist?.keyFiles.length ?? 0;
  const downloadOk = keyFileCount > 0 && verifiedKeyCount === keyFileCount;
  const simulationEvidence = summary.productionGate?.simulationEvidence;
  const postprocessTrace = summary.postprocessTraceReport;
  const simulationOk = Boolean(simulationEvidence?.productionUnlockEligible);
  const postprocessTraceOk = postprocessTrace?.level === "ready";
  const simulationLevel: V3EvidenceLoopItem["level"] = simulationOk
    ? "ok"
    : simulationEvidence?.synthetic || simulationEvidence?.level === "review"
      ? "warning"
      : "critical";
  const postprocessTraceLevel: V3EvidenceLoopItem["level"] = postprocessTraceOk
    ? "ok"
    : postprocessTrace?.level === "critical"
      ? "critical"
      : "warning";
  const trialLog = summary.trialFeedbackLog;
  const trialOk = trialLog?.latestOutcome === "success";
  const trialLevel: V3EvidenceLoopItem["level"] = trialOk
    ? "ok"
    : trialLog?.latestOutcome === "failed"
      ? "critical"
      : "warning";
  const acceptanceLog = summary.machineAcceptanceLog;
  const acceptanceOk = Boolean(acceptanceLog?.allRequiredPassed);
  const localAcceptanceOk = machineAcceptance.airRun && machineAcceptance.softTrial;
  const acceptanceLevel: V3EvidenceLoopItem["level"] = acceptanceOk
    ? "ok"
    : acceptanceLog?.latestOutcome === "failed"
      ? "critical"
      : localAcceptanceOk
        ? "warning"
        : "critical";

  const items: V3EvidenceLoopItem[] = [
    {
      id: "download-integrity",
      title: "下载核验",
      level: downloadOk ? "ok" : "critical",
      value: keyFileCount > 0 ? `${verifiedKeyCount}/${keyFileCount}` : "未生成",
      detail: downloadOk
        ? "关键 NC/仿真文件均有 SHA-256，可按核验清单比对。"
        : "缺少关键文件哈希或交付清单，不能进入上机验收。"
    },
    {
      id: "simulation",
      title: "材料去除仿真",
      level: simulationLevel,
      value: simulationEvidence?.level ?? "未导入",
      detail: simulationOk
        ? "仿真证据满足生产解锁要求。"
        : simulationEvidence?.summary ?? "需要 CAMotics 或等效材料去除仿真结果。"
    },
    {
      id: "postprocess-trace",
      title: "后处理追溯",
      level: postprocessTraceLevel,
      value: postprocessTrace ? `${(postprocessTrace.metrics.fitRate * 100).toFixed(2)}%` : "未生成",
      detail: postprocessTrace
        ? postprocessTrace.summary
        : "需要生成 postprocess-trace-report.json，逐点核对 toolpath.nc。"
    },
    {
      id: "trial-feedback",
      title: "试雕反馈",
      level: trialLevel,
      value: trialLog ? `${trialLog.recordCount} 条` : "未回填",
      detail: trialLog
        ? `最新结论：${formatFeedbackOutcome(trialLog.latestOutcome)}。`
        : "需要在反馈页记录软材料或低风险试雕结果。"
    },
    {
      id: "machine-acceptance",
      title: "机床验收",
      level: acceptanceLevel,
      value: acceptanceLog ? `${acceptanceLog.recordCount} 条` : localAcceptanceOk ? "本地待同步" : "未通过",
      detail: acceptanceOk
        ? "必需验收项已同步到 V3 证据链。"
        : localAcceptanceOk
          ? "本地空跑/试雕已记录，建议同步到 V3 证据链。"
          : "至少需要通过旋转标定空跑、整条空跑和软材料试雕。"
    }
  ];

  const nextActions: string[] = [];
  if (!downloadOk) nextActions.push("重新运行 V3 小闭环并下载加工包，按 operator-download-checklist.md 核验文件。");
  if (!simulationOk) nextActions.push("导入真实 CAMotics 材料去除结果，替换 synthetic/内部预览证据。");
  if (!postprocessTraceOk) nextActions.push("查看 postprocess-trace-report.json，修正后处理轴映射或点位错位后重新生成。");
  if (!trialOk) nextActions.push("到反馈页记录软材料试雕结果，失败项要带缺陷标签和备注。");
  if (!acceptanceOk) nextActions.push(localAcceptanceOk ? "点击“同步到V3证据链”回填机床验收。" : "先完成空跑、旋转标定和软材料试雕，再同步机床验收。");
  if (nextActions.length === 0) nextActions.push("闭环证据已齐，仍需确认真实机床参数和刀具装夹后再开放生产 NC。");

  const criticalCount = items.filter((item) => item.level === "critical").length;
  const warningCount = items.filter((item) => item.level === "warning").length;
  return {
    level: criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok",
    title: criticalCount > 0 ? "V3 闭环仍有阻断项" : warningCount > 0 ? "V3 闭环可继续试雕" : "V3 闭环证据已齐",
    detail: criticalCount > 0
      ? "当前只能做离料空跑、仿真或软材料验证，不能当作生产 CAM 输出。"
      : warningCount > 0
        ? "已有关键产物，但还需要补齐真实仿真或实机反馈。"
        : "下载核验、仿真、试雕和机床验收均已形成证据链。",
    items,
    nextActions
  };
}

function formatV3ShortcutFileLabel(filename: string) {
  if (filename === "rotary-calibration-airrun.nc") return "旋转标定空跑";
  if (filename === "air-run.nc") return "整条刀路空跑";
  if (filename === "toolpath.nc") return "候选刀路NC";
  if (filename === "camotics-preview.nc") return "CAMotics预览";
  if (filename === "camotics-cli-run-package.json") return "CAMotics运行包";
  if (filename === "camotics-result-template.json") return "结果回填模板";
  if (filename === "camotics-linux-run.sh") return "Linux运行脚本";
  if (filename === "camotics-result-validate.js") return "结果校验脚本";
  if (filename === "camotics-linux-operator-checklist.md") return "Linux操作清单";
  if (filename === "camotics-cli-package-report.json") return "运行包报告";
  if (filename === "camotics-execution-preflight.json") return "仿真预检JSON";
  if (filename === "camotics-execution-preflight.md") return "仿真预检说明";
  if (filename === "safe-trial-execution-plan.json") return "安全试雕执行计划";
  if (filename === "next-action-checklist.md") return "下一步清单";
  if (filename === "linux-cam-closed-loop-handoff.md") return "闭环交接说明";
  if (filename === "operator-download-checklist.md") return "下载核验清单";
  if (filename === "operator-runbook.md") return "操作员说明";
  if (filename === "machining-package-index.json") return "加工包索引";
  if (filename === "cam-handoff-evidence.md") return "CAM交接证据";
  if (filename === "open-source-cam-execution-plan.json") return "开源CAM执行计划";
  if (filename === "opencamlib-cutter-envelope-report.json") return "OpenCAMLib包络报告";
  if (filename === "postprocess-trace-report.json") return "后处理追溯";
  return filename;
}

function formatV3MachineUseClass(machineUseClass: string) {
  if (machineUseClass === "trial-or-production-candidate") return "候选上机 NC";
  if (machineUseClass === "locked-machine-nc") return "锁定 NC";
  if (machineUseClass === "air-run-no-cut") return "离料空跑";
  if (machineUseClass === "simulation-only-never-machine") return "仅仿真";
  if (machineUseClass === "cam-input-only") return "CAM 输入";
  if (machineUseClass === "report-only") return "报告";
  return machineUseClass;
}

function getV3MachineFileCardClass(file: {
  allowedOnMachine: boolean;
  machineUseClass: string;
  verified: boolean;
}) {
  if (!file.verified) return "critical";
  if (file.machineUseClass === "simulation-only-never-machine") return "never-machine";
  if (file.machineUseClass === "air-run-no-cut") return "air-run";
  if (file.allowedOnMachine) return "machine";
  return "locked";
}

function getProductionDownloadTitle(
  isOperatorMode: boolean,
  exportBlocked: boolean,
  exportGateReady: boolean,
  v3ProductionGate: V3OrchestratorJob["result"]["summary"]["productionGate"] | null
) {
  if (v3ProductionGate && !v3ProductionGate.allowProductionNc) {
    return `V3 production-gate 未解锁正式生产 NC：${v3ProductionGate.summary}`;
  }
  if (isOperatorMode && !exportGateReady) return "操作员模式：只能下载已通过安全校验并完成正式确认的文件";
  if (exportBlocked) return "导出前安全校验存在阻断项";
  if (!exportGateReady) return "请先完成正式导出确认";
  return "下载已确认文件";
}

function createSafetyGateStatus(toolpath: GeneratedToolpath | null, safetyIssues: SafetyIssue[], exportGate: ExportGateState): SafetyGateStatus {
  const criticalCount = safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = safetyIssues.filter((issue) => issue.level === "warning").length;
  if (!toolpath || criticalCount > 0) {
    return {
      level: "blocked",
      title: "禁止上机",
      detail: !toolpath ? "尚未生成刀路，只允许调整参数和查看预检查提示。" : `存在 ${criticalCount} 个 critical 阻断项，只允许下载报告和离料空跑文件。`,
      canDownloadProduction: false
    };
  }

  const checkedCount = [exportGate.safetyReportReviewed, exportGate.airRunVerified, exportGate.fixtureConfirmed].filter(Boolean).length;
  if (checkedCount === 3) {
    return {
      level: "trial",
      title: "可试雕",
      detail: warningCount > 0 ? `已完成三项闸口确认，但仍有 ${warningCount} 个提醒；建议先软材料或降进给试雕。` : "安全报告、离料空跑和夹持确认已完成，可下载正式加工文件。",
      canDownloadProduction: true
    };
  }

  if (warningCount > 0) {
    return {
      level: "repair",
      title: "建议修复",
      detail: `当前有 ${warningCount} 个提醒，正式文件继续锁定；修复参数或完成三项确认后再试雕。`,
      canDownloadProduction: false
    };
  }

  return {
    level: "air-run",
    title: "可空跑",
    detail: "未发现阻断项。请先下载安全报告、完成离料空跑，并确认夹持区和刀具装夹。",
    canDownloadProduction: false
  };
}

function captureWorkbenchPreviewPng() {
  const canvas = document.querySelector<HTMLCanvasElement>(".workbench .viewer canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrlToUint8Array(dataUrl);
  } catch {
    return null;
  }
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToUint8Array(dataUrl: string) {
  const [, base64 = ""] = dataUrl.split(",");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createPreviewIndexMarkdown(input: {
  sourceLabel: string;
  workbenchView: WorkbenchView;
  hasPreviewPng: boolean;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
  envelopeHeatmapDiagnosis: ReturnType<typeof createEnvelopeHeatmapDiagnosis> | null;
  meshQuality: MeshQualityReport | null;
  materialRemoval: MaterialRemovalReport | null;
}) {
  return [
    "# 加工包预览索引",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `模型来源：${input.sourceLabel}`,
    `导出时右侧视图：${formatWorkbenchView(input.workbenchView)}`,
    "",
    "## 自动归档",
    "",
    input.hasPreviewPng ? "- `preview/simulation-result.png`：导出瞬间右侧工作区截图" : "- 未捕获到工作区截图，可能是当前视图没有 Canvas。",
    "- `reports/manufacturing-summary.md`：上机前关键指标摘要",
    "- `parameters.json`：完整参数、质量、包络和成本快照",
    "",
    "## 建议复核视图",
    "",
    "- 3D模型：检查模型朝向、长轴、端部是否完整。",
    "- 模拟雕刻：检查刀路包络是否贴合目标曲面。",
    "- 热力图：检查风险格、最差 X/A 区域和连续风险带。",
    "- 报告摘要：检查安全闸口、材料去除、成本和质量评分。",
    "",
    "## 当前关键指标",
    "",
    input.meshQuality ? `- Mesh 评分：${input.meshQuality.score.toFixed(1)} / 100，长轴 ${input.meshQuality.detectedLongAxis.toUpperCase()}` : "- Mesh 评分：未生成",
    input.envelopeQuality ? `- 包络贴合率：${input.envelopeQuality.fitRate.toFixed(1)}%，未贴合 ${input.envelopeQuality.missCount}` : "- 包络贴合率：未生成",
    input.envelopeHeatmapDiagnosis ? `- 热力图风险格：${input.envelopeHeatmapDiagnosis.riskCellRate.toFixed(1)}%，最差区域 ${input.envelopeHeatmapDiagnosis.worstCellLabel}` : "- 热力图风险格：未生成",
    input.materialRemoval ? `- 材料去除评分：${input.materialRemoval.score.toFixed(1)} / 100，残料风险 ${input.materialRemoval.residualRiskMm.toFixed(3)}mm` : "- 材料去除评分：未生成"
  ].join("\n");
}

function createManufacturingSummaryMarkdown(input: {
  reportInput: Parameters<typeof createOperatorPackageMarkdown>[0];
  costEstimate: CostEstimate | null;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
  envelopeHeatmapDiagnosis: ReturnType<typeof createEnvelopeHeatmapDiagnosis> | null;
  safetyGateStatus: SafetyGateStatus;
}) {
  const { reportInput } = input;
  const criticalCount = reportInput.safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = reportInput.safetyIssues.filter((issue) => issue.level === "warning").length;
  return [
    "# 制造摘要",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `安全闸口：${input.safetyGateStatus.title}`,
    `阻断/提醒：${criticalCount} / ${warningCount}`,
    "",
    "## 加工程序",
    "",
    `- 合并程序：${reportInput.toolpath.estimatedMinutes.toFixed(1)} min`,
    reportInput.toolpath.programs?.rough ? `- 粗加工：${reportInput.toolpath.programs.rough.estimatedMinutes.toFixed(1)} min` : "- 粗加工：无独立程序",
    reportInput.toolpath.programs?.finish ? `- 精加工：${reportInput.toolpath.programs.finish.estimatedMinutes.toFixed(1)} min` : "- 精加工：无独立程序",
    reportInput.toolpath.programs?.rest ? `- 清残：${reportInput.toolpath.programs.rest.estimatedMinutes.toFixed(1)} min` : "- 清残：无独立程序",
    "",
    "## 质量与风险",
    "",
    `- 加工质量：${reportInput.manufacturingQuality.score.toFixed(1)} / 100，${reportInput.manufacturingQuality.summary}`,
    reportInput.materialRemoval ? `- 材料去除：${reportInput.materialRemoval.score.toFixed(1)} / 100，${reportInput.materialRemoval.summary}` : "- 材料去除：未生成",
    input.envelopeQuality ? `- 包络贴合：${input.envelopeQuality.fitRate.toFixed(1)}%，连续贴合 ${input.envelopeQuality.continuityRate.toFixed(1)}%` : "- 包络贴合：未生成",
    input.envelopeHeatmapDiagnosis ? `- 热力图：风险格 ${input.envelopeHeatmapDiagnosis.riskCellRate.toFixed(1)}%，最差 ${input.envelopeHeatmapDiagnosis.worstCellLabel}` : "- 热力图：未生成",
    reportInput.meshQuality ? `- Mesh：${reportInput.meshQuality.score.toFixed(1)} / 100，边界边 ${reportInput.meshQuality.boundaryEdges}` : "- Mesh：未生成",
    "",
    "## 工时与成本",
    "",
    input.costEstimate
      ? `- 总占机：${input.costEstimate.totalMinutes.toFixed(1)} min，综合估算 ${formatCurrencyRange(input.costEstimate.totalCostLow, input.costEstimate.totalCostHigh)}`
      : "- 尚未生成成本估算。",
    "",
    "## 上机顺序",
    "",
    "1. 先运行离料空跑 NC，确认 X/A/Z 方向和夹具间隙。",
    "2. 若热力图或包络诊断存在风险，先修复 Mesh 或调整步距后重新导出。",
    "3. 首次正式材料建议降进给试雕，再逐步恢复模板参数。"
  ].join("\n");
}

function formatWorkbenchView(view: WorkbenchView) {
  if (view === "simulation") return "模拟雕刻";
  if (view === "heatmap") return "包络热力图";
  if (view === "gcode") return "G-code";
  if (view === "report") return "报告摘要";
  return "3D模型";
}

function createPackageParameters(input: {
  projectProfile: ProjectProfile;
  deploymentProfile: DeploymentProfile;
  machineAcceptance: MachineAcceptanceRecord;
  settings: ModelSettings;
  sourceLabel: string;
  aiMeshUrl: string | null;
  aiMeshStlUrl: string | null;
  selectedTool: ToolProfile;
  selectedMaterial: MaterialProfile;
  selectedMachine: MachineProfile;
  toolpath: GeneratedToolpath;
  manufacturingQuality: ManufacturingQualityReport;
  materialRemoval: MaterialRemovalReport | null;
  meshQuality: MeshQualityReport | null;
  costEstimate: CostEstimate | null;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
  envelopeHeatmapDiagnosis: ReturnType<typeof createEnvelopeHeatmapDiagnosis> | null;
  exportGate: ExportGateState;
  safetyGateStatus: SafetyGateStatus;
}) {
  return {
    packageVersion: "V2",
    createdAt: new Date().toISOString(),
    project: input.projectProfile,
    deployment: input.deploymentProfile,
    machineAcceptance: input.machineAcceptance,
    exportGate: {
      ...input.exportGate,
      level: input.safetyGateStatus.level,
      title: input.safetyGateStatus.title,
      detail: input.safetyGateStatus.detail,
      productionUnlocked: input.safetyGateStatus.canDownloadProduction
    },
    source: {
      label: input.sourceLabel,
      aiMeshUrl: input.aiMeshUrl,
      aiMeshStlUrl: input.aiMeshStlUrl
    },
    machine: input.selectedMachine,
    tool: input.selectedTool,
    material: input.selectedMaterial,
    settings: input.settings,
    toolpath: {
      postProcessorName: input.toolpath.postProcessorName,
      estimatedMinutes: input.toolpath.estimatedMinutes,
      summary: input.toolpath.summary,
      programFiles: {
        rough: input.toolpath.programs?.rough?.filename ?? null,
        finish: input.toolpath.programs?.finish?.filename ?? null,
        rest: input.toolpath.programs?.rest?.filename ?? null,
        combined: input.toolpath.programs?.combined?.filename ?? "nuclear-carving-combined.nc",
        airRun: input.toolpath.programs?.airRun?.filename ?? null
      }
    },
    quality: {
      manufacturing: input.manufacturingQuality,
      materialRemoval: input.materialRemoval,
      mesh: input.meshQuality,
      envelope: input.envelopeQuality,
      envelopeHeatmap: input.envelopeHeatmapDiagnosis
    },
    costEstimate: input.costEstimate
  };
}

function createPackageChecklist(
  input: Parameters<typeof createOperatorPackageMarkdown>[0],
  exportGateReady: boolean,
  usesAiMesh: boolean,
  safetyGateStatus: SafetyGateStatus
) {
  const criticalCount = input.safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = input.safetyIssues.filter((issue) => issue.level === "warning").length;
  return [
    "# ZIP 加工包交付检查清单",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `正式导出状态：${exportGateReady ? "已完成确认" : "未完成确认"}`,
    `安全闸口等级：${safetyGateStatus.title}`,
    `风险项：阻断 ${criticalCount} / 提醒 ${warningCount}`,
    "",
    "## 必查文件",
    "",
    "- [ ] `operator-note.md` 已阅读",
    "- [ ] `reports/safety-report.json` 已复核",
    "- [ ] `parameters.json` 已归档",
    "- [ ] `preview/simulation-result.png` 已查看",
    "- [ ] `nc/nuclear-carving-air-run.nc` 已先空跑",
    `- [ ] 当前机床离料空跑验收：${input.machineAcceptance?.airRun ? "已记录" : "未记录"}`,
    `- [ ] 当前机床软材料试雕：${input.machineAcceptance?.softTrial ? "已记录" : "建议补充"}`,
    "- [ ] 正式 NC/TAP/TXT 文件已按目标机床后处理确认",
    usesAiMesh ? "- [ ] `models/model-download-links.md` 中的 GLB/STL 已单独归档" : "- [ ] `models/source.stl` 已归档",
    "",
    "## 上机前确认",
    "",
    `- 机床：${input.machine.name}`,
    `- 刀具：${input.tool.name}`,
    `- 材料：${input.material.name}`,
    `- 左/右夹持：${input.settings.leftHoldMm.toFixed(1)} / ${input.settings.rightHoldMm.toFixed(1)} mm`,
    `- 安全高度：${input.settings.safeZ.toFixed(2)} mm`,
    `- 估算时间：${input.toolpath.estimatedMinutes.toFixed(1)} min`,
    "",
    "## 结论",
    "",
    criticalCount > 0
      ? "- 当前存在阻断项，不建议直接上机。"
      : "- 当前可进入离料空跑和低风险试雕流程。"
  ].join("\n");
}

function createFileSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

type EnvelopeHeatmapCell = {
  key: string;
  xIndex: number;
  aIndex: number;
  total: number;
  missCount: number;
  fitRate: number;
  status: "ok" | "warning" | "critical" | "empty";
};

function EnvelopeHeatmapPreview({
  toolpath,
  settings,
  envelopeQuality,
  heatmapDiagnosis
}: {
  toolpath: GeneratedToolpath;
  settings: ModelSettings;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality>;
  heatmapDiagnosis: ReturnType<typeof createEnvelopeHeatmapDiagnosis> | null;
}) {
  const heatmap = heatmapDiagnosis?.heatmap ?? createEnvelopeHeatmapCells(toolpath, settings);
  const maxSamples = Math.max(1, ...heatmap.cells.map((cell) => cell.total));
  const sourceLabel = toolpath.previewPoints && toolpath.previewPoints.length > 0 ? "Mesh 表面采样" : "刀路覆盖估算";

  return (
    <div className="workbench-panel heatmap-panel">
      <div className={`heatmap-verdict ${envelopeQuality.diagnosis.level}`}>
        <div>
          <span>{sourceLabel}</span>
          <strong>{envelopeQuality.diagnosis.title}</strong>
          <small>{envelopeQuality.diagnosis.detail}</small>
        </div>
        <b>{envelopeQuality.score.toFixed(1)}</b>
      </div>

      <div className="heatmap-summary">
        <div>
          <span>包络评分</span>
          <strong>{envelopeQuality.score.toFixed(1)} / 100</strong>
        </div>
        <div>
          <span>贴合率</span>
          <strong>{envelopeQuality.fitRate.toFixed(1)}%</strong>
        </div>
        <div>
          <span>未贴合点</span>
          <strong>{envelopeQuality.missCount.toLocaleString()}</strong>
        </div>
        <div>
          <span>连续贴合</span>
          <strong>{envelopeQuality.continuityRate.toFixed(1)}%</strong>
        </div>
        {heatmapDiagnosis && (
          <>
            <div>
              <span>风险格占比</span>
              <strong>{heatmapDiagnosis.riskCellRate.toFixed(1)}%</strong>
            </div>
            <div>
              <span>最差区域</span>
              <strong>{heatmapDiagnosis.worstCellLabel}</strong>
            </div>
          </>
        )}
      </div>

      <div className="heatmap-layout">
        <div className="heatmap-axis y-axis">{heatmap.secondaryAxisName}</div>
        <div
          className="heatmap-grid"
          style={{ gridTemplateColumns: `repeat(${heatmap.xBins}, minmax(0, 1fr))` }}
          aria-label="包络误差热力图"
        >
          {heatmap.cells.map((cell) => {
            const opacity = cell.total > 0 ? 0.38 + (cell.total / maxSamples) * 0.62 : 1;
            const xStart = heatmap.xLabels[cell.xIndex] ?? "";
            const secondaryStart = heatmap.secondaryLabels[cell.aIndex] ?? "";
            const title = `X ${xStart} / ${heatmap.secondaryShortName} ${secondaryStart} / 样本 ${cell.total} / 未贴合 ${cell.missCount} / 贴合 ${cell.fitRate.toFixed(1)}%`;
            return (
              <span
                className={`heatmap-cell ${cell.status}`}
                key={cell.key}
                style={{ opacity }}
                title={title}
              />
            );
          })}
        </div>
        <div className="heatmap-axis x-axis">X 长度方向</div>
      </div>

      <div className="heatmap-legend">
        <span><i className="ok" />贴合良好</span>
        <span><i className="warning" />局部风险</span>
        <span><i className="critical" />未贴合集中</span>
        <span><i className="empty" />无采样</span>
      </div>

      {heatmapDiagnosis && (
        <div className="heatmap-risk-list">
          {heatmapDiagnosis.riskItems.map((item) => (
            <div className={item.status} key={item.label}>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>
      )}

      <div className="heatmap-suggestions">
        {(heatmapDiagnosis?.suggestions ?? envelopeQuality.diagnosis.suggestions).map((suggestion) => (
          <p key={suggestion}>{suggestion}</p>
        ))}
      </div>
    </div>
  );
}

function createEnvelopeHeatmapCells(toolpath: GeneratedToolpath, settings: ModelSettings) {
  const xBins = 28;
  const aBins = 18;
  const halfLength = settings.lengthMm / 2;
  const usesThreeAxis = settings.camMode === "3axis" || toolpath.summary.yMin != null;
  const halfWidth = settings.diameterMm / 2;
  const samples = usesThreeAxis
    ? toolpath.points.map((point) => ({
      x: point.x,
      secondary: (point.y ?? 0) + halfWidth,
      hit: true
    }))
    : toolpath.previewPoints && toolpath.previewPoints.length > 0
    ? toolpath.previewPoints.map((point) => ({
      x: point.x,
      secondary: normalizeAngleDeg((Math.atan2(point.y, point.z) * 180) / Math.PI),
      hit: point.hit
    }))
    : toolpath.points.map((point) => ({
      x: point.x,
      secondary: normalizeAngleDeg(point.a),
      hit: true
    }));
  const buckets = Array.from({ length: xBins * aBins }, (_, index) => ({
    total: 0,
    missCount: 0,
    xIndex: index % xBins,
    aIndex: Math.floor(index / xBins)
  }));

  for (const sample of samples) {
    const xRatio = THREEClamp((sample.x + halfLength) / Math.max(0.001, settings.lengthMm), 0, 0.999999);
    const secondaryRatio = usesThreeAxis
      ? THREEClamp(sample.secondary / Math.max(0.001, settings.diameterMm), 0, 0.999999)
      : THREEClamp(sample.secondary / 360, 0, 0.999999);
    const xIndex = Math.floor(xRatio * xBins);
    const aIndex = aBins - 1 - Math.floor(secondaryRatio * aBins);
    const bucket = buckets[aIndex * xBins + xIndex];
    bucket.total += 1;
    if (!sample.hit) bucket.missCount += 1;
  }

  const cells: EnvelopeHeatmapCell[] = buckets.map((bucket) => {
    const fitRate = bucket.total > 0 ? ((bucket.total - bucket.missCount) / bucket.total) * 100 : 100;
    const status = bucket.total === 0 ? "empty" : fitRate >= 96 ? "ok" : fitRate >= 88 ? "warning" : "critical";
    return {
      key: `${bucket.xIndex}-${bucket.aIndex}`,
      xIndex: bucket.xIndex,
      aIndex: bucket.aIndex,
      total: bucket.total,
      missCount: bucket.missCount,
      fitRate,
      status
    };
  });

  return {
    cells,
    xBins,
    aBins,
    xLabels: Array.from({ length: xBins }, (_, index) => `${(-halfLength + (settings.lengthMm * index) / xBins).toFixed(1)}mm`),
    secondaryLabels: usesThreeAxis
      ? Array.from({ length: aBins }, (_, index) => `${(-halfWidth + (settings.diameterMm * (aBins - 1 - index)) / aBins).toFixed(1)}mm`)
      : Array.from({ length: aBins }, (_, index) => `${Math.round((360 * (aBins - 1 - index)) / aBins)}deg`),
    secondaryAxisName: usesThreeAxis ? "Y 宽度方向" : "A 轴角度",
    secondaryShortName: usesThreeAxis ? "Y" : "A"
  };
}

function createEnvelopeHeatmapDiagnosis(
  toolpath: GeneratedToolpath,
  settings: ModelSettings,
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality>
) {
  const heatmap = createEnvelopeHeatmapCells(toolpath, settings);
  const sampledCells = heatmap.cells.filter((cell) => cell.total > 0);
  const riskCells = sampledCells.filter((cell) => cell.status === "warning" || cell.status === "critical");
  const criticalCells = sampledCells.filter((cell) => cell.status === "critical");
  const worstCell = sampledCells.reduce<EnvelopeHeatmapCell | null>((worst, cell) => {
    if (!worst) return cell;
    if (cell.fitRate < worst.fitRate) return cell;
    if (cell.fitRate === worst.fitRate && cell.missCount > worst.missCount) return cell;
    return worst;
  }, null);
  const riskCellRate = sampledCells.length > 0 ? (riskCells.length / sampledCells.length) * 100 : 0;
  const criticalCellRate = sampledCells.length > 0 ? (criticalCells.length / sampledCells.length) * 100 : 0;
  const worstCellLabel = worstCell ? formatHeatmapCellLabel(worstCell, heatmap) : "无采样";
  const bandStats = createHeatmapBandStats(heatmap);
  const riskItems = [
    {
      label: "风险格占比",
      detail: `风险格 ${riskCells.length}/${sampledCells.length}，严重风险格 ${criticalCells.length}。`,
      status: riskCellRate <= 4 ? "ok" : riskCellRate <= 14 ? "warning" : "critical"
    },
    {
      label: `最差 X/${heatmap.secondaryShortName} 区域`,
      detail: worstCell ? `${worstCellLabel}，贴合 ${worstCell.fitRate.toFixed(1)}%，未贴合 ${worstCell.missCount}/${worstCell.total}。` : "当前没有可统计采样。",
      status: !worstCell || worstCell.fitRate >= 96 ? "ok" : worstCell.fitRate >= 88 ? "warning" : "critical"
    },
    {
      label: "连续风险带",
      detail: bandStats.detail,
      status: bandStats.status
    }
  ] as Array<{ label: string; detail: string; status: "ok" | "warning" | "critical" }>;

  const suggestions = [...envelopeQuality.diagnosis.suggestions];
  if (criticalCellRate > 8) suggestions.unshift("热力图显示严重未贴合区域较多，建议先修复 Mesh/校准长轴，再重新生成刀路。");
  else if (riskCellRate > 10) suggestions.unshift("热力图存在成片风险格，建议降低步距并重新检查夹持端部过渡。");
  if (bandStats.status !== "ok") suggestions.push(bandStats.action);
  if (worstCell && worstCell.xIndex <= 3) suggestions.push("最差区域靠近左端，优先检查左夹持保留、端部过渡和 Mesh 左端是否缺面。");
  if (worstCell && worstCell.xIndex >= heatmap.xBins - 4) suggestions.push("最差区域靠近右端，优先检查右夹持保留、端部过渡和 Mesh 右端是否缺面。");

  return {
    heatmap,
    riskCellRate,
    criticalCellRate,
    worstCellLabel,
    riskItems,
    suggestions: Array.from(new Set(suggestions))
  };
}

function formatHeatmapCellLabel(cell: EnvelopeHeatmapCell, heatmap: ReturnType<typeof createEnvelopeHeatmapCells>) {
  return `X ${heatmap.xLabels[cell.xIndex] ?? "-"} / ${heatmap.secondaryShortName} ${heatmap.secondaryLabels[cell.aIndex] ?? "-"}`;
}

function createHeatmapBandStats(heatmap: ReturnType<typeof createEnvelopeHeatmapCells>) {
  const xRisk = Array.from({ length: heatmap.xBins }, (_, xIndex) => heatmap.cells.filter((cell) => cell.xIndex === xIndex && cell.status === "critical").length);
  const aRisk = Array.from({ length: heatmap.aBins }, (_, aIndex) => heatmap.cells.filter((cell) => cell.aIndex === aIndex && cell.status === "critical").length);
  const worstX = xRisk.reduce((best, value, index) => (value > best.value ? { index, value } : best), { index: 0, value: 0 });
  const worstA = aRisk.reduce((best, value, index) => (value > best.value ? { index, value } : best), { index: 0, value: 0 });
  const status: "ok" | "warning" | "critical" = worstX.value >= 4 || worstA.value >= 4 ? "critical" : worstX.value >= 2 || worstA.value >= 2 ? "warning" : "ok";
  if (status === "ok") {
    return {
      status,
      detail: "未发现连续严重风险带。",
      action: "热力图未发现连续风险带，可继续做模拟雕刻和空跑验证。"
    };
  }
  const xLabel = heatmap.xLabels[worstX.index] ?? "-";
  const aLabel = heatmap.secondaryLabels[worstA.index] ?? "-";
  const dominant = worstX.value >= worstA.value ? `X ${xLabel}` : `${heatmap.secondaryShortName} ${aLabel}`;
  return {
    status,
    detail: `${dominant} 附近存在连续严重风险格，X向 ${worstX.value} 格，${heatmap.secondaryShortName}向 ${worstA.value} 格。`,
    action: worstX.value >= worstA.value
      ? "连续风险沿 X 方向集中，建议检查端部保留、模型长轴校准和 X 步距。"
      : heatmap.secondaryShortName === "Y"
        ? "连续风险沿 Y 方向集中，建议检查三轴模型宽度、Y 步距和 Mesh 左右侧缺损。"
        : "连续风险沿 A 方向集中，建议检查旋转轴方向、A 步距和 Mesh 顶/底部缺损。"
  };
}

function normalizeAngleDeg(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function WorkbenchReportSummary({
  exportBlocked,
  manufacturingQuality,
  materialRemoval,
  costEstimate,
  envelopeQuality,
  safetyIssues
}: {
  exportBlocked: boolean;
  manufacturingQuality: ManufacturingQualityReport;
  materialRemoval: MaterialRemovalReport | null;
  costEstimate: CostEstimate | null;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
  safetyIssues: SafetyIssue[];
}) {
  const criticalCount = safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = safetyIssues.filter((issue) => issue.level === "warning").length;

  return (
    <div className="workbench-panel report-preview">
      <div className={`report-verdict ${exportBlocked ? "blocked" : manufacturingQuality.verdict}`}>
        <strong>{exportBlocked ? "禁止直接上机" : manufacturingQuality.summary}</strong>
        <span>阻断 {criticalCount} 项 / 提醒 {warningCount} 项</span>
      </div>
      <div className="report-preview-grid">
        <div>
          <span>加工质量</span>
          <strong>{manufacturingQuality.score.toFixed(1)} / 100</strong>
          <small>{manufacturingQuality.summary}</small>
        </div>
        <div>
          <span>材料去除</span>
          <strong>{materialRemoval ? `${materialRemoval.score.toFixed(1)} / 100` : "待生成"}</strong>
          <small>{materialRemoval?.summary ?? "生成刀路后显示仿真指标"}</small>
        </div>
        <div>
          <span>包络贴合</span>
          <strong>{envelopeQuality ? `${envelopeQuality.fitRate.toFixed(1)}%` : "待生成"}</strong>
          <small>{envelopeQuality ? `未贴合 ${envelopeQuality.missCount} 点` : "生成刀路后计算"}</small>
        </div>
        <div>
          <span>成本估算</span>
          <strong>{costEstimate ? formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh) : "待生成"}</strong>
          <small>{costEstimate ? `总占机 ${costEstimate.totalMinutes.toFixed(1)} min` : "生成刀路后估算"}</small>
        </div>
      </div>
      <div className="report-preview-list">
        {manufacturingQuality.items.slice(0, 5).map((item) => (
          <div className={item.status} key={item.label}>
            <strong>{item.label}：{item.value}</strong>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
};

function Control({ label, value, min, max, step, suffix, onChange }: ControlProps) {
  return (
    <label className="control">
      <span>
        {label}
        <strong>{value}{suffix}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function getToolpathProgram(toolpath: GeneratedToolpath, kind: ToolpathKind) {
  if (kind === "rough") return toolpath.programs?.rough ?? null;
  if (kind === "finish") return toolpath.programs?.finish ?? null;
  return toolpath.programs?.rest ?? null;
}

function getToolpathKindLabel(kind: ToolpathKind) {
  if (kind === "rough") return "粗加工刀路";
  if (kind === "finish") return "精加工刀路";
  return "清残刀路";
}

function getToolpathKindColorLabel(kind: ToolpathKind) {
  if (kind === "rough") return "橙红=粗加工";
  if (kind === "finish") return "紫色=精加工";
  return "琥珀=清残";
}

function getToolpathSurfaceColor(kind: ToolpathKind) {
  if (kind === "rough") return 0xb95a1b;
  if (kind === "finish") return 0x9a6ff0;
  return 0xc78313;
}

function createFinishingSettings(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    reliefAngleDeg: 360,
    stepoverMm: Math.min(settings.stepoverMm, Math.max(0.05, settings.toolDiameter * 0.18)),
    stepoverDeg: Math.min(settings.stepoverDeg, 0.6),
    feedRate: Math.max(30, Math.round(settings.feedRate * 0.65))
  };
}

function analyzeEnvelopeQuality(toolpath: GeneratedToolpath, settings: ModelSettings) {
  const preview = toolpath.previewPoints ?? [];
  const sourceCount = preview.length > 0 ? preview.length : toolpath.points.length;
  const hitCount = preview.length > 0 ? preview.filter((point) => point.hit).length : toolpath.points.length;
  const safeCutoff = settings.safeZ * 0.92;
  const safeMoveCount = toolpath.points.filter((point) => point.z >= safeCutoff).length;
  const missCount = Math.max(0, sourceCount - hitCount);
  const fitRate = sourceCount > 0 ? (hitCount / sourceCount) * 100 : 0;
  const safeRate = toolpath.points.length > 0 ? (safeMoveCount / toolpath.points.length) * 100 : 0;
  const continuityRate = preview.length > 1 ? calculateContinuityRate(preview) : 100;
  const zJumpRate = calculateZJumpRate(toolpath.points, settings);
  const score = THREEClamp(fitRate * 0.58 + continuityRate * 0.28 + (100 - safeRate) * 0.1 + (100 - zJumpRate) * 0.04, 0, 100);
  const regions = createEnvelopeRegionStats(preview, toolpath.points, settings);
  const diagnosis = createEnvelopeDiagnosis({ fitRate, missCount, continuityRate, zJumpRate, regions });

  return {
    score,
    fitRate,
    missCount,
    continuityRate,
    safeRate,
    zJumpRate,
    regions,
    diagnosis
  };
}

type EnvelopeRegionStat = {
  label: string;
  total: number;
  missCount: number;
  fitRate: number;
  status: "ok" | "warning" | "critical";
};

function createEnvelopeRegionStats(
  preview: Array<{ x: number; y: number; z: number; hit: boolean }>,
  toolpathPoints: Array<{ x: number; a: number }>,
  settings: ModelSettings
): EnvelopeRegionStat[] {
  const regions = [
    createRegionBucket("左端"),
    createRegionBucket("主体"),
    createRegionBucket("右端"),
    createRegionBucket("顶部"),
    createRegionBucket("底部")
  ];

  const samples = preview.length > 0
    ? preview.map((point) => ({ x: point.x, angle: Math.atan2(point.y, point.z), hit: point.hit }))
    : toolpathPoints.map((point) => ({ x: point.x, angle: (point.a * Math.PI) / 180, hit: true }));

  const halfLength = settings.lengthMm / 2;
  const leftLimit = -halfLength + settings.leftHoldMm + Math.max(settings.endTransitionMm, settings.toolDiameter);
  const rightLimit = halfLength - settings.rightHoldMm - Math.max(settings.endTransitionMm, settings.toolDiameter);

  for (const point of samples) {
    if (point.x <= leftLimit) addRegionSample(regions[0], point.hit);
    else if (point.x >= rightLimit) addRegionSample(regions[2], point.hit);
    else addRegionSample(regions[1], point.hit);

    if (point.angle > Math.PI * 0.22 && point.angle < Math.PI * 0.78) {
      addRegionSample(regions[3], point.hit);
    }
    if (point.angle < -Math.PI * 0.22 && point.angle > -Math.PI * 0.78) {
      addRegionSample(regions[4], point.hit);
    }
  }

  return regions.map((region) => finalizeRegion(region));
}

function createRegionBucket(label: string) {
  return { label, total: 0, missCount: 0 };
}

function addRegionSample(region: { total: number; missCount: number }, hit: boolean) {
  region.total += 1;
  if (!hit) region.missCount += 1;
}

function finalizeRegion(region: { label: string; total: number; missCount: number }): EnvelopeRegionStat {
  const fitRate = region.total > 0 ? ((region.total - region.missCount) / region.total) * 100 : 100;
  return {
    ...region,
    fitRate,
    status: fitRate >= 96 ? "ok" : fitRate >= 88 ? "warning" : "critical"
  };
}

function createEnvelopeDiagnosis(input: {
  fitRate: number;
  missCount: number;
  continuityRate: number;
  zJumpRate: number;
  regions: EnvelopeRegionStat[];
}) {
  const problematic = input.regions.filter((region) => region.total > 0 && region.status !== "ok").sort((a, b) => a.fitRate - b.fitRate);
  const worst = problematic[0];
  const suggestions: string[] = [];
  let title = "包络贴合正常";
  let detail = "当前刀路采样与目标网格整体贴合，未发现明显区域性缺损。";
  let level: "ok" | "warning" | "critical" = "ok";

  if (input.fitRate < 88 || input.continuityRate < 82) {
    level = "critical";
    title = "存在明显未贴合区域";
    detail = worst ? `${worst.label}贴合率最低，仅 ${worst.fitRate.toFixed(1)}%，可能来自 Mesh 缺损、姿态偏轴或端部过渡过窄。` : "整体贴合率偏低，请优先检查 Mesh 质量和旋转轴。";
  } else if (input.fitRate < 96 || problematic.length > 0) {
    level = "warning";
    title = "局部区域建议复核";
    detail = worst ? `${worst.label}存在局部未贴合，贴合率 ${worst.fitRate.toFixed(1)}%。` : "整体贴合可用，但建议上机前复核局部细节。";
  }

  if (problematic.some((region) => region.label === "左端" || region.label === "右端")) {
    suggestions.push("未贴合集中在两端时，优先检查夹持区、端部过渡和 AI Mesh 端部是否缺面。");
  }
  if (problematic.some((region) => region.label === "顶部" || region.label === "底部")) {
    suggestions.push("未贴合集中在顶部/底部时，优先使用 Mesh 修复、重网格或重新校准旋转轴。");
  }
  if (input.zJumpRate > 8) {
    suggestions.push("Z 向跳变偏多，建议降低步距、平滑 Mesh 或减小单层切深。");
  }
  if (input.missCount > 0 && suggestions.length === 0) {
    suggestions.push("存在少量未贴合点，可先模拟雕刻并查看粉色标记是否集中成片。");
  }
  if (suggestions.length === 0) {
    suggestions.push("包络指标正常，可继续做模拟雕刻和空跑验证。");
  }

  return { level, title, detail, suggestions };
}

function calculateContinuityRate(points: Array<{ hit: boolean }>) {
  let totalTransitions = 0;
  let continuousHits = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (!points[i - 1].hit && !points[i].hit) continue;
    totalTransitions += 1;
    if (points[i - 1].hit && points[i].hit) {
      continuousHits += 1;
    }
  }
  return totalTransitions > 0 ? (continuousHits / totalTransitions) * 100 : 100;
}

function calculateZJumpRate(points: Array<{ z: number }>, settings: ModelSettings) {
  if (points.length < 2) return 0;
  const jumpThreshold = Math.max(settings.toolDiameter * 2.5, settings.depthMm * 1.8, 0.5);
  let jumps = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i].z - points[i - 1].z) > jumpThreshold) {
      jumps += 1;
    }
  }
  return (jumps / (points.length - 1)) * 100;
}

function THREEClamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function depthMapToPreviewUrl(depthMap: DepthMap): string {
  const canvas = document.createElement("canvas");
  canvas.width = depthMap.width;
  canvas.height = depthMap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const image = ctx.createImageData(depthMap.width, depthMap.height);
  for (let i = 0; i < depthMap.values.length; i += 1) {
    const shade = Math.round(255 - depthMap.values[i] * 235);
    const p = i * 4;
    image.data[p] = shade;
    image.data[p + 1] = Math.max(0, shade - 22);
    image.data[p + 2] = Math.max(0, shade - 48);
    image.data[p + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function createCaptureGuideReport(images: CarvingImage[]): CaptureGuideReport {
  const angleSlots = [
    { label: "正面", angleDeg: 0 },
    { label: "左侧", angleDeg: 90 },
    { label: "右侧", angleDeg: 270 },
    { label: "背面", angleDeg: 180 }
  ];
  const slots = angleSlots.map(({ label, angleDeg }, index): CaptureGuideSlot => {
    const image = images[index];
    if (!image) {
      return {
        label,
        angleDeg,
        imageName: null,
        score: null,
        status: "missing",
        hint: "缺少该角度",
        issue: "角度缺失",
        retakeAction: `补拍 ${angleDeg}° ${label}，核胚长轴保持水平，主体占画面约 60%。`
      };
    }

    const score = image.quality?.score ?? 60;
    const status: CaptureGuideSlot["status"] = score >= 82 ? "ready" : score >= 64 ? "usable" : "retake";
    const advice = createCaptureSlotAdvice(image, label, angleDeg);
    return {
      label,
      angleDeg,
      imageName: image.name,
      score,
      status,
      hint: status === "ready" ? `${score.toFixed(1)} 分，可用` : status === "usable" ? `${score.toFixed(1)} 分，建议复核` : `${score.toFixed(1)} 分，建议重拍`,
      issue: advice.issue,
      retakeAction: advice.action
    };
  });

  const presentSlots = slots.filter((slot) => slot.status !== "missing");
  const missingCount = slots.length - presentSlots.length;
  const retakeCount = slots.filter((slot) => slot.status === "retake").length;
  const usableCount = slots.filter((slot) => slot.status === "usable").length;
  const averageQuality = presentSlots.length > 0 ? presentSlots.reduce((sum, slot) => sum + (slot.score ?? 0), 0) / presentSlots.length : 0;
  const coverageScore = Math.min(1, images.length / 4) * 42;
  const qualityScore = Math.min(1, averageQuality / 90) * 48;
  const penalty = retakeCount * 12 + usableCount * 4 + Math.max(0, images.length - 4) * 2;
  const score = THREEClamp(coverageScore + qualityScore + (missingCount === 0 ? 10 : 0) - penalty, 0, 100);
  const verdict: CaptureGuideReport["verdict"] = score >= 82 && missingCount === 0 && retakeCount === 0 ? "ready" : score >= 62 && images.length >= 2 ? "usable" : "retake";
  const summary =
    verdict === "ready"
      ? "适合进入 AI 多图 3D 生成"
      : verdict === "usable"
        ? "可用于测试，建议补齐或复核角度"
        : "建议补拍后再生成 3D Mesh";

  const suggestions: string[] = [];
  if (images.length < 4) suggestions.push(`建议补齐 4 个角度，目前还缺 ${4 - images.length} 张。`);
  if (images.length > 4) suggestions.push("Meshy 多图入口最多使用前 4 张，请把最佳角度排在前面。");
  if (missingCount > 0) suggestions.push(`缺少：${slots.filter((slot) => slot.status === "missing").map((slot) => slot.label).join("、")}。`);
  if (retakeCount > 0) suggestions.push("存在低质量照片，请优先按下方补拍动作重拍，再调用 Meshy 多图 3D。");
  if (usableCount > 0) suggestions.push("部分照片可用于测试，但正式生成前建议复核主体居中、边缘清晰和背景反差。");
  if (images.length >= 2 && images.length < 4) suggestions.push("只有 2-3 张时适合快速测试；想得到完整 360° 立体 Mesh，建议补齐正/左/右/背四个方向。");
  if (suggestions.length === 0) suggestions.push("角度覆盖和基础质量正常，可以进入 Meshy 或其他 AI Provider 生成。");

  return { score, verdict, summary, slots, suggestions };
}

function createCaptureSlotAdvice(image: CarvingImage, label: string, angleDeg: number) {
  const critical = image.quality?.metrics.find((metric) => metric.status === "critical");
  const warning = image.quality?.metrics.find((metric) => metric.status === "warning");
  const metric = critical ?? warning;
  if (!metric) {
    return {
      issue: "质量达标",
      action: `${angleDeg}° ${label} 可用；保持同一焦距、同一背景和同一光向继续拍摄其他角度。`
    };
  }

  const prefix = `${angleDeg}° ${label}`;
  if (metric.label === "主体覆盖") {
    return metric.value < 18
      ? { issue: "主体占画面偏小", action: `${prefix} 需要靠近拍摄或裁切背景，主体建议占画面 55%-70%。` }
      : { issue: "主体贴边过多", action: `${prefix} 需要后退一点，左右和上下都留出完整轮廓边缘。` };
  }

  if (metric.label === "深度对比") {
    return {
      issue: "主体与背景反差不足",
      action: `${prefix} 建议使用纯色亚光背景，从侧前方补光，避免背景纹理抢边缘。`
    };
  }

  if (metric.label === "边缘清晰") {
    return {
      issue: "边缘清晰度不足",
      action: `${prefix} 建议固定手机/相机，点按主体重新对焦，快门前等待画面稳定。`
    };
  }

  if (metric.label === "主体居中") {
    return {
      issue: "主体偏离中心",
      action: `${prefix} 重拍时让核胚中心落在画面中心线，长轴保持水平。`
    };
  }

  return {
    issue: `${metric.label}需复核`,
    action: `${prefix} 建议重拍一张同角度照片，并保持纯色背景、稳定对焦和均匀补光。`
  };
}

function scoreAiProvider(provider: (typeof ai3dProviders)[number], imageCount: number, captureScore: number) {
  let score = provider.status === "available" ? 46 : provider.status === "local" ? 28 : 18;
  score += Math.min(imageCount, provider.maxImages) * 8;
  score += Math.min(18, captureScore * 0.16);
  if (provider.productionFit === "ready") score += 16;
  if (provider.productionFit === "pilot") score += 8;
  if (provider.privacy === "local") score += 6;
  return THREEClamp(score, 0, 100);
}

function formatProviderScore(score: number) {
  if (score >= 78) return "推荐";
  if (score >= 58) return "可试";
  if (score >= 38) return "需配置";
  return "待接入";
}

function formatProviderStatus(status: (typeof ai3dProviders)[number]["status"]) {
  if (status === "available") return "已接入";
  if (status === "local") return "本地预留";
  return "预留";
}

function formatProviderTraits(provider: (typeof ai3dProviders)[number]) {
  const speed = provider.speed === "fast" ? "快" : provider.speed === "medium" ? "中" : "慢";
  const privacy = provider.privacy === "local" ? "本地" : provider.privacy === "private" ? "私有" : "云端";
  const fit = provider.productionFit === "ready" ? "生产" : provider.productionFit === "pilot" ? "试点" : "研究";
  const cost = provider.costLevel === "low" ? "低成本" : provider.costLevel === "medium" ? "中成本" : provider.costLevel === "high" ? "高成本" : "成本浮动";
  return `${speed} / ${privacy} / ${fit} / ${cost}`;
}

function createMeshCalibrationGuide(meshQuality: MeshQualityReport, settings: ModelSettings) {
  const axis = meshQuality.detectedLongAxis;
  const selectedAxis = settings.meshLengthAxis === "auto" ? axis : settings.meshLengthAxis;
  const axisOk = selectedAxis === axis;
  const dims = meshQuality.dimensions;
  const meshLength = Math.max(0.001, dims[axis]);
  const diameterAxes = (["x", "y", "z"] as const).filter((item) => item !== axis);
  const meshDiameter = Math.max(0.001, (dims[diameterAxes[0]] + dims[diameterAxes[1]]) / 2);
  const lengthDelta = Math.abs(settings.lengthMm - meshLength) / Math.max(1, settings.lengthMm);
  const diameterDelta = Math.abs(settings.diameterMm - meshDiameter) / Math.max(1, settings.diameterMm);
  const scaleOk = lengthDelta <= 0.18 && diameterDelta <= 0.22;
  const reverseHint = settings.meshAxisReverse ? "当前已反向，生成刀路后重点看左右端是否互换。" : "当前未反向；若刀路左右颠倒，再打开反向采样。";
  const status: "ok" | "warning" | "critical" = axisOk && scaleOk ? "ok" : axisOk || scaleOk ? "warning" : "critical";

  return {
    status,
    title: status === "ok" ? "姿态比例基本匹配" : status === "warning" ? "建议复核姿态或比例" : "姿态比例需要校准",
    detail: `体检长轴 ${axis.toUpperCase()}，Mesh 约 ${meshLength.toFixed(1)} x ${meshDiameter.toFixed(1)}mm；当前核胚 ${settings.lengthMm.toFixed(1)} x ${settings.diameterMm.toFixed(1)}mm。`,
    steps: [
      {
        label: "旋转长轴",
        value: axisOk ? "匹配" : "不一致",
        status: axisOk ? "ok" : "critical",
        detail: axisOk ? `CAM 将沿 ${selectedAxis.toUpperCase()} 轴展开。` : `建议采用体检长轴 ${axis.toUpperCase()}，避免刀路沿错误方向包覆。`
      },
      {
        label: "比例尺寸",
        value: scaleOk ? "接近" : "偏差",
        status: scaleOk ? "ok" : "warning",
        detail: `长度差 ${(lengthDelta * 100).toFixed(0)}%，直径差 ${(diameterDelta * 100).toFixed(0)}%。`
      },
      {
        label: "采样方向",
        value: settings.meshAxisReverse ? "已反向" : "未反向",
        status: "ok",
        detail: reverseHint
      }
    ]
  };
}

async function imageToDataUri(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片转base64失败"));
    reader.readAsDataURL(blob);
  });
}

async function pollMeshyTask(taskId: string, onStatus: (status: string) => void) {
  return pollAi3dTask(`/api/meshy/multi-image-to-3d/${encodeURIComponent(taskId)}`, onStatus, "Meshy任务");
}

async function pollMeshyTaskByEndpoint(endpoint: string, onStatus: (status: string) => void, label: string) {
  return pollAi3dTask(endpoint, onStatus, label);
}

function createV3PackageReadme(job: V3OrchestratorJob) {
  const summary = job.result?.summary;
  const gate = summary?.productionGate;
  const productionUnlockMatrix = summary?.productionUnlockMatrix;
  const productionEvidenceDossier = summary?.productionEvidenceDossier;
  const productionCrossChecks = productionEvidenceDossier?.crossChecks;
  const manifest = summary?.deliveryManifest;
  const preflight = summary?.adapterPreflight;
  const engineReadiness = summary?.engineReadiness;
  const repairExecution = summary?.repairExecution;
  const repairedMeshQuality = repairExecution?.repairedMeshQuality;
  const camInputPlan = summary?.camInputPlan;
  const camModelSelection = camInputPlan?.modelSelection;
  const postprocessProfile = summary?.postprocessProfile;
  const machineControllerProfile = summary?.machineControllerProfile;
  const ncStaticAnalysis = summary?.ncStaticAnalysis;
  const camHandoffQuality = summary?.camHandoffQuality;
  const neutralToolpathImportValidation = summary?.neutralToolpathImportValidation;
  const neutralMachineFit = neutralToolpathImportValidation?.machineFit;
  const rotaryWrapPreviewReport = summary?.rotaryWrapPreviewReport;
  const postprocessTraceReport = summary?.postprocessTraceReport;
  const controllerDialectReport = summary?.controllerDialectReport;
  const camoticsInput = summary?.camoticsInput;
  const camoticsSimulationPlan = summary?.camoticsSimulationPlan;
  const camoticsCliPackage = summary?.camoticsCliPackage;
  const packageIndex = summary?.machiningPackageIndex;
  const camoticsExecutionPreflight = summary?.camoticsExecutionPreflight ?? packageIndex?.camotics?.executionPreflight;
  const simulation = summary?.simulation;
  const camoticsAdapter = simulation?.camoticsAdapter;
  const camoticsEvidenceQuality = gate?.simulationEvidence?.evidenceQuality ?? camoticsAdapter?.evidenceQuality;
  const packageIntegrity = summary?.packageIntegrity;
  const operatorRunbook = summary?.operatorRunbook;
  const trialFeedbackTemplate = summary?.trialFeedbackTemplate;
  const toolSetupSheet = summary?.toolSetupSheet;
  const rotaryCalibrationSheet = summary?.rotaryCalibrationSheet;
  const machineAcceptanceChecklist = summary?.machineAcceptanceChecklist;
  const machineAcceptanceSummary = packageIndex?.machineAcceptance;
  const externalCamRecipe = summary?.externalCamRecipe;
  const camEngineSelection = summary?.camEngineSelection;
  const camServerConfig = summary?.camServerConfig;
  const cutterEnvelopeReportFile = manifest?.files.find((file) => file.filename === "opencamlib-cutter-envelope-report.json");
  const lines = [
    "# HeDiao3D V3 加工包",
    "",
    `Job ID: ${job.id}`,
    `状态: ${job.status}`,
    `生成时间: ${job.updatedAt}`,
    `包级别: ${manifest?.packageLevel ?? gate?.level ?? "unknown"}`,
    "",
    "## 生产门禁",
    "",
    `结论: ${gate?.summary ?? "未生成生产门禁"}`,
    `允许生产NC: ${gate?.allowProductionNc ? "是" : "否"}`,
    `允许试雕NC: ${gate?.allowTrialNc ? "是" : "否"}`,
    `允许离料空跑: ${gate?.allowAirRun ? "是" : "否"}`,
    `解锁矩阵: 通过 ${productionUnlockMatrix?.passCount ?? "-"} / 复核 ${productionUnlockMatrix?.reviewCount ?? "-"} / 阻断 ${productionUnlockMatrix?.blockCount ?? "-"}`,
    "矩阵报告: production-unlock-matrix.json",
    `证据档案: ${productionEvidenceDossier?.status ?? "未生成"} / 通过 ${productionEvidenceDossier?.passedCount ?? "-"} / 复核 ${productionEvidenceDossier?.reviewCount ?? "-"} / 阻断 ${productionEvidenceDossier?.blockedCount ?? "-"}`,
    `现场证据缺口: ${productionEvidenceDossier?.fieldEvidenceGaps?.length ? productionEvidenceDossier.fieldEvidenceGaps.map((item) => item.label).join("、") : "无"}`,
    "证据档案报告: production-evidence-dossier.json",
    "",
    "### 生产交叉校验",
    "",
    ...createProductionCrossCheckReadmeLines(productionCrossChecks),
    "",
    `CAM交接质量: ${camHandoffQuality?.level ?? "未生成"} / ${camHandoffQuality?.source ?? "-"}`,
    "CAM交接报告: cam-handoff-quality.json",
    "CAM交接证据: cam-handoff-evidence.md",
    `Neutral导入校验: ${neutralToolpathImportValidation?.status ?? "未生成"} / ${neutralToolpathImportValidation?.postprocessEligible ? "可进入后处理" : neutralToolpathImportValidation ? "已拒绝" : "-"}`,
    `Neutral导入点数: ${neutralToolpathImportValidation?.metrics?.sourcePointCount ?? "-"} / 归一化 ${neutralToolpathImportValidation?.metrics?.normalizedPointCount ?? "-"} / 越界 ${neutralToolpathImportValidation?.metrics?.outOfRangeCount ?? "-"}`,
    `Neutral导入来源: ${neutralToolpathImportValidation?.engine ?? "-"} / ${neutralToolpathImportValidation?.sourceName ?? "-"}`,
    `Neutral源绑定: ${neutralToolpathImportValidation?.sourceBinding?.status ?? "-"} / 输入 ${neutralToolpathImportValidation?.sourceBinding?.submitted?.sha256 ? `${neutralToolpathImportValidation.sourceBinding.submitted.sha256.slice(0, 12)}...` : "-"} / 后处理 ${neutralToolpathImportValidation?.sourceBinding?.sourceSnapshot?.matchesPostprocessArtifact ? "匹配" : neutralToolpathImportValidation?.sourceBinding ? "待复核" : "-"}`,
    `Neutral机床适配: ${neutralMachineFit?.level ?? "未生成"} / ${neutralMachineFit?.targetMachine?.axisMapping ?? "-"}`,
    `Neutral覆盖: X ${neutralMachineFit?.coverage?.xCoverageRatio !== undefined ? `${(neutralMachineFit.coverage.xCoverageRatio * 100).toFixed(1)}%` : "-"} / 旋转 ${neutralMachineFit?.coverage?.rotarySpanDeg !== undefined ? `${neutralMachineFit.coverage.rotarySpanDeg.toFixed(1)}°` : "-"} / 目标 ${neutralMachineFit?.coverage?.expectedRotaryCoverageDeg !== undefined ? `${neutralMachineFit.coverage.expectedRotaryCoverageDeg.toFixed(1)}°` : "-"}`,
    `Neutral风险: 端部 ${neutralMachineFit?.riskCounts?.holdZonePointCount ?? "-"} / 超深 ${neutralMachineFit?.riskCounts?.deepPointCount ?? "-"} / 越界 ${neutralMachineFit?.riskCounts?.outOfRangeCount ?? "-"}`,
    "Neutral导入校验报告: neutral-toolpath-import-validation.json",
    `旋转包裹预览: ${rotaryWrapPreviewReport?.level ?? "未生成"} / 机床覆盖 ${rotaryWrapPreviewReport?.metrics?.machineCoverage !== null && rotaryWrapPreviewReport?.metrics?.machineCoverage !== undefined ? `${(rotaryWrapPreviewReport.metrics.machineCoverage * 100).toFixed(1)}%` : "-"} / 线性化误差 ${rotaryWrapPreviewReport?.metrics?.linearizationErrorRate !== null && rotaryWrapPreviewReport?.metrics?.linearizationErrorRate !== undefined ? `${(rotaryWrapPreviewReport.metrics.linearizationErrorRate * 100).toFixed(2)}%` : "-"}`,
    "旋转包裹预览报告: rotary-wrap-preview-report.json",
    `后处理追溯: ${postprocessTraceReport?.level ?? "未生成"} / 匹配 ${postprocessTraceReport?.metrics?.fitRate !== null && postprocessTraceReport?.metrics?.fitRate !== undefined ? `${(postprocessTraceReport.metrics.fitRate * 100).toFixed(2)}%` : "-"} / 核对 ${postprocessTraceReport?.metrics?.matched ?? "-"}/${postprocessTraceReport?.metrics?.compared ?? "-"}`,
    `后处理最大偏差: X ${postprocessTraceReport?.metrics?.maxAbs?.lengthMm !== undefined ? `${postprocessTraceReport.metrics.maxAbs.lengthMm.toFixed(4)}mm` : "-"} / 旋转 ${postprocessTraceReport?.metrics?.maxAbs?.rotaryMachine !== undefined ? postprocessTraceReport.metrics.maxAbs.rotaryMachine.toFixed(4) : "-"} / Z ${postprocessTraceReport?.metrics?.maxAbs?.zMm !== undefined ? `${postprocessTraceReport.metrics.maxAbs.zMm.toFixed(4)}mm` : "-"}`,
    "后处理追溯报告: postprocess-trace-report.json",
    `外部摄取源: ${camHandoffQuality?.sourceSnapshot ? `${camHandoffQuality.sourceSnapshot.kind} / ${camHandoffQuality.sourceSnapshot.sha256.slice(0, 12)}` : "无"}`,
    `OpenCAMLib包络报告: ${cutterEnvelopeReportFile ? "opencamlib-cutter-envelope-report.json / preview审计证据" : "未生成"}`,
    cutterEnvelopeReportFile
      ? "OpenCAMLib包络边界: 该报告记录STL高度场刀具半径包络、命中率和深度统计，但仍是preview scaffold，不能单独解锁生产NC。"
      : "OpenCAMLib包络边界: 未生成包络审计报告，真实生产仍需外部CAM候选、CAMotics材料去除仿真和机床验收。",
    "",
    "## 机床验收",
    "",
    `状态: ${machineAcceptanceChecklist?.summary ?? machineAcceptanceSummary?.summary ?? "未生成"}`,
    `验收清单: ${machineAcceptanceSummary?.artifact ?? "machine-acceptance-checklist.json"}`,
    `必需步骤: ${machineAcceptanceSummary?.requiredStepCount ?? machineAcceptanceChecklist?.steps?.filter((step) => step.required).length ?? 0}`,
    `阻断步骤: ${machineAcceptanceSummary?.blockedStepCount ?? machineAcceptanceChecklist?.steps?.filter((step) => step.blocksProduction).length ?? 0}`,
    ...(machineAcceptanceChecklist?.unresolvedRisks?.length ? machineAcceptanceChecklist.unresolvedRisks.slice(0, 5).map((risk) => `未解决风险: ${risk}`) : ["未解决风险: 无"]),
    "",
    "## 加工包完整性",
    "",
    `状态: ${packageIntegrity?.status ?? "未生成"}`,
    `说明: ${packageIntegrity?.summary ?? "-"}`,
    `文件数: ${packageIntegrity?.downloadableCount ?? "-"}/${packageIntegrity?.fileCount ?? "-"}`,
    `缺失可下载文件: ${packageIntegrity?.missingDownloadableCount ?? "-"}`,
    "完整性报告: package-integrity.json",
    `操作员说明书: ${operatorRunbook?.artifact ?? "operator-runbook.md"}`,
    `试雕反馈模板: ${trialFeedbackTemplate?.schema ? "trial-feedback-template.json" : "未生成"}`,
    "",
    "## 刀具核验",
    "",
    `刀具: ${toolSetupSheet?.tool?.name ?? "-"}`,
    `几何: D${toolSetupSheet?.tool?.diameterMm ?? "-"} / ${toolSetupSheet?.tool?.angleDeg ? `${toolSetupSheet.tool.angleDeg}deg` : "-"} / 平底 ${toolSetupSheet?.tool?.flatTipMm ?? "-"}mm`,
    `切深/步距: ${toolSetupSheet?.cutting?.maxCutDepthMm ?? "-"}mm / ${toolSetupSheet?.cutting?.stepoverMm ?? "-"}mm`,
    `进给/转速: F${toolSetupSheet?.cutting?.feedRateMmMin ?? "-"} / S${toolSetupSheet?.cutting?.spindleRpm ?? "-"}`,
    `复核项: ${toolSetupSheet?.warnings?.length ?? 0}`,
    "刀具报告: tool-setup-sheet.json",
    "",
    "## 旋转夹具标定",
    "",
    `模式: ${rotaryCalibrationSheet?.mode ?? "-"}`,
    `轴映射: ${rotaryCalibrationSheet?.axisMapping?.lengthAxis ?? "-"} / ${rotaryCalibrationSheet?.axisMapping?.rotaryAxis ?? "-"} / ${rotaryCalibrationSheet?.axisMapping?.depthAxis ?? "-"}`,
    `每圈距离: ${rotaryCalibrationSheet?.axisMapping?.rotaryWrapPerRevolutionMm ?? "-"}mm`,
    `每毫米角度: ${rotaryCalibrationSheet?.axisMapping?.rotaryDegPerLinearMm ?? "-"}deg/mm`,
    `复核项: ${rotaryCalibrationSheet?.warnings?.length ?? 0}`,
    `标定空跑: ${manifest?.files.some((file) => file.filename === "rotary-calibration-airrun.nc") ? "rotary-calibration-airrun.nc" : "未生成"}`,
    "建议顺序: 先运行 rotary-calibration-airrun.nc，再运行 air-run.nc，最后低进给试雕。",
    "标定报告: rotary-calibration-sheet.json",
    "",
    "## 外部CAM状态",
    "",
    `Mesh修复执行: ${repairExecution?.summary ?? "未生成"}`,
    `修复产物导入: ${repairExecution?.importedRepair?.imported ? `是 / ${repairExecution.importedRepair.filename ?? "repaired-model.stl"}` : "否"}`,
    `修复后Mesh体检: ${repairedMeshQuality ? `${typeof repairedMeshQuality.score === "number" ? repairedMeshQuality.score.toFixed(1) : "-"} / ${repairedMeshQuality.verdict ?? "unknown"}` : "未生成"}`,
    `修复后边界/非流形/退化面: ${repairedMeshQuality ? `${repairedMeshQuality.boundaryEdges ?? "-"} / ${repairedMeshQuality.nonManifoldEdges ?? "-"} / ${repairedMeshQuality.degenerateFaces ?? "-"}` : "-"}`,
    `修复后质量报告: ${repairedMeshQuality?.artifact ?? "未生成"}`,
    `CAM输入模型: ${camModelSelection?.selectedModelId ?? camInputPlan?.selectedModelKind ?? "-"}`,
    `CAM模型角色: ${camModelSelection?.selectedModelRole ?? "-"}`,
    `CAM输入路径: ${camModelSelection?.selectedModelPath ?? camInputPlan?.selectedModelPath ?? "-"}`,
    `CAM模型选择: ${camModelSelection?.selectionReason ?? camInputPlan?.summary ?? "-"}`,
    `CAM模型阻断: ${camModelSelection?.blockingReason ?? "无"}`,
    `CAM候选模型: ${camModelSelection?.candidates?.filter((candidate) => candidate.exists).length ?? 0}/${camModelSelection?.candidates?.length ?? repairExecution?.outputs?.length ?? 0}`,
    `引擎诊断: ${engineReadiness?.summary ?? "未生成"}`,
    `CAM选择: ${camEngineSelection?.selectedEngineName ?? "-"} / ${camEngineSelection?.fallbackUsed ? "fallback" : "external-attempt"}`,
    `选择原因: ${camEngineSelection?.fallbackReason ?? "-"}`,
    `CAM服务器配置: ${camServerConfig?.status ?? "未生成"} / ${camServerConfig?.selectedEngineName ?? "-"} / 缺失 ${camServerConfig?.missingRequired?.length ?? "-"}`,
    "CAM服务器配置报告: cam-server-config.json",
    `Adapter预检: ${preflight?.summary ?? "未生成"}`,
    "",
    "## 外部CAM配方",
    "",
    `状态: ${externalCamRecipe?.status ?? "未生成"}`,
    `引擎: ${externalCamRecipe?.engine?.selectedEngineName ?? "-"}`,
    `工序: ${externalCamRecipe?.operations?.filter((operation) => operation.enabled).length ?? 0}/${externalCamRecipe?.operations?.length ?? 0}`,
    `后处理策略: ${externalCamRecipe?.postprocess?.policy ?? "-"}`,
    "",
    "## 后处理配置",
    "",
    `后处理: ${postprocessProfile?.postProcessorName ?? summary?.postProcessorName ?? "未生成"}`,
    `CAM模式: ${postprocessProfile?.camMode ?? "unknown"}`,
    `长度轴: ${postprocessProfile?.coordinateMapping?.lengthAxis ?? "-"}`,
    `旋转轴: ${postprocessProfile?.coordinateMapping?.rotaryAxis ?? "-"}`,
    `旋转等效: ${postprocessProfile?.machine?.rotaryWrapPerRevolutionMm ? `${postprocessProfile.machine.rotaryWrapPerRevolutionMm} mm/圈` : "-"}`,
    `刀具: ${postprocessProfile?.tool?.description ?? "-"} / ${postprocessProfile?.tool?.toolDiameterMm ?? "-"} mm`,
    "",
    "## 机床控制器配置",
    "",
    `配置: ${machineControllerProfile?.name ?? "未生成"}`,
    `控制器类型: ${machineControllerProfile?.controllerClass ?? "-"}`,
    `长度轴: ${machineControllerProfile?.axisMapping?.lengthAxis ?? "-"}`,
    `刀深轴: ${machineControllerProfile?.axisMapping?.depthAxis ?? "-"}`,
    `旋转轴: ${machineControllerProfile?.rotary?.outputAxis ?? "-"}`,
    `旋转等效: ${machineControllerProfile?.rotary?.wrapPerRevolutionMm ? `${machineControllerProfile.rotary.wrapPerRevolutionMm} mm/圈` : "-"}`,
    `允许轴字: ${machineControllerProfile?.dialect?.allowedWords?.join(", ") ?? "-"}`,
    `安全Z: ${machineControllerProfile?.safety?.safeZMm ?? "-"} mm`,
    "",
    "## NC静态分析",
    "",
    `等级: ${ncStaticAnalysis?.level ?? "未生成"}`,
    `结论: ${ncStaticAnalysis?.summary ?? "-"}`,
    `阻断项: ${ncStaticAnalysis?.criticalIssues?.length ?? 0}`,
    `复核项: ${ncStaticAnalysis?.warningIssues?.length ?? 0}`,
    "",
    "## 控制器方言",
    "",
    `等级: ${controllerDialectReport?.level ?? "未生成"}`,
    `方言: ${controllerDialectReport?.dialect?.name ?? "-"}`,
    `结论: ${controllerDialectReport?.summary ?? "-"}`,
    `阻断项: ${controllerDialectReport?.criticalIssues?.length ?? 0}`,
    `复核项: ${controllerDialectReport?.warningIssues?.length ?? 0}`,
    "",
    "## CAMotics 输入",
    "",
    `状态: ${camoticsInput?.status ?? "未生成"}`,
    `解释方式: ${camoticsInput?.compatibility?.interpretation ?? "-"}`,
    `可在CAMotics检查: ${camoticsInput?.compatibility?.canRunInCamotics ? "是，按三轴/展开刀路检查" : "否，需要旋转轴仿真软件复核"}`,
    "推荐文件: camotics-preview.nc（仅仿真，不可上机）",
    `说明: ${camoticsInput?.compatibility?.reason ?? "-"}`,
    `项目模板: ${camoticsSimulationPlan?.projectTemplate?.schema ? "camotics-project-template.json" : "未生成"}`,
    `计划状态: ${camoticsSimulationPlan?.status ?? "未生成"}`,
    "",
    "## CAMotics Linux 准备包",
    "",
    `状态: ${camoticsCliPackage?.status ?? packageIndex?.camotics?.cliRunPackage?.artifact ?? "未生成"}`,
    `运行包: ${camoticsCliPackage?.artifact ?? packageIndex?.camotics?.cliRunPackage?.artifact ?? "未生成"}`,
    `结果模板: ${camoticsCliPackage?.resultTemplate ?? packageIndex?.camotics?.cliRunPackage?.resultTemplate ?? "未生成"}`,
    `Linux脚本: ${camoticsCliPackage?.linuxRunScript ?? packageIndex?.camotics?.cliRunPackage?.linuxRunScript ?? "未生成"}`,
    `准备包报告: ${camoticsCliPackage?.report ?? packageIndex?.camotics?.cliRunPackage?.report ?? "未生成"}`,
    `执行预检: ${camoticsExecutionPreflight?.status ?? "未生成"} / 当前主机${camoticsExecutionPreflight?.canRunOnCurrentHost ? "可执行" : "需Linux CAM服务器"}`,
    `预检报告: ${camoticsExecutionPreflight?.artifact ?? "未生成"} / ${camoticsExecutionPreflight?.report ?? "未生成"}`,
    `预览NC哈希: ${camoticsCliPackage?.preferredGcodeSha256 ?? "-"}`,
    `运动画像: ${camoticsCliPackage?.motionProfile ? `${camoticsCliPackage.motionProfile.motionLineCount} 行 / Z ${camoticsCliPackage.motionProfile.zMin ?? "-"} 到 ${camoticsCliPackage.motionProfile.zMax ?? "-"}` : "-"}`,
    `生产解锁: ${camoticsCliPackage?.productionUnlockEligible ? "异常：准备包不应直接解锁生产" : "否，准备包只用于真实材料去除仿真准备"}`,
    "操作顺序: 下载 camotics-cli-run-package.json、camotics-linux-run.sh、camotics-result-template.json 和 camotics-result-validate.js 到 Linux CAM 服务器；执行/复核 CAMotics 后填写真实 camotics-result.json，先运行 node camotics-result-validate.js，通过后再回填到 V3 面板。",
    "注意: camotics-preview.nc 仅用于展开三轴仿真，禁止上机；toolpath.nc 仍受 production-gate.json 控制。",
    "",
    "## CAMotics 仿真结果",
    "",
    `仿真引擎: ${simulation?.engine ?? "未生成"}`,
    `Adapter状态: ${camoticsAdapter?.status ?? "未运行"}`,
    `结果类型: ${camoticsAdapter?.synthetic ? "synthetic链路验证，不代表真实材料去除" : camoticsAdapter?.status === "completed" ? "CAMotics材料去除结果" : "无结果"}`,
    `结果文件: ${packageIndex?.camotics?.resultFile ?? camoticsAdapter?.resultArtifact ?? "-"}`,
    `运动行数: ${camoticsAdapter?.metrics?.motionLineCount ?? "-"}`,
    `证据状态: ${camoticsEvidenceQuality?.status ?? "-"}`,
    `生产证据资格: ${camoticsEvidenceQuality?.productionEvidenceEligible ? "是" : "否"}`,
    `运行包绑定: ${camoticsEvidenceQuality?.inputIdentity?.cliRunPackage?.status ?? "-"} / ${camoticsEvidenceQuality?.inputIdentity?.cliRunPackage?.required ? "必需" : "未要求"}`,
    `运行包哈希: ${camoticsEvidenceQuality?.inputIdentity?.cliRunPackage?.expectedSha256 ? `${camoticsEvidenceQuality.inputIdentity.cliRunPackage.expectedSha256.slice(0, 12)}...` : "-"}`,
    `机床上下文: ${camoticsEvidenceQuality?.machineContext?.status ?? packageIndex?.camotics?.machineContextStatus ?? "-"} / X长度-Y旋转展开-Z刀深`,
    `证据缺失项: ${camoticsEvidenceQuality?.missing?.length ? camoticsEvidenceQuality.missing.join(", ") : "无"}`,
    `说明: ${camoticsAdapter?.summary ?? packageIndex?.camotics?.limitation ?? "-"}`,
    "",
    "## 刀路摘要",
    "",
    `结果引擎: ${job.result?.engine ?? "unknown"}`,
    `fallbackFrom: ${job.result?.fallbackFrom ?? "unknown"}`,
    `点数: ${summary?.points ?? 0}`,
    `估算时间: ${summary?.estimatedMinutes?.toFixed?.(1) ?? "-"} min`,
    "",
    "## 操作建议",
    "",
    ...(packageIndex?.recommendedSequence?.length
      ? packageIndex.recommendedSequence.map((item) => `- ${item}`)
      : gate?.requiredActions?.length
        ? gate.requiredActions.map((item) => `- ${item}`)
        : ["- 先查看 machining-package-index.json、production-gate.json 和 delivery-manifest.json。"]),
    "",
    "## 机器用途分类",
    "",
    "- trial-or-production-candidate: 需要通过 production-gate.json 门禁后才可按试雕/生产流程上机。",
    "- locked-machine-nc: 机床 NC 已生成但门禁未放行，禁止上机。",
    "- air-run-no-cut: 只允许离料空跑，主轴关闭，不切削材料。",
    "- simulation-only-never-machine: 仅用于 CAMotics/预览，禁止上机。",
    "- cam-input-only/report-only: 只作为 CAM 输入或报告，不是机床程序。",
    "",
    "## 文件说明",
    "",
    ...(manifest?.files.map((file) => {
      const machineUse = file.machineUse ? `用途 ${file.machineUse.class}，${file.machineUse.allowedOnMachine ? "允许按规则上机" : "不可上机"}。` : "";
      return `- ${file.filename}: ${file.label}，${file.downloadable ? "已打包" : "未打包"}。${machineUse}${file.note}`;
    }) ?? [])
  ];
  return `${lines.join("\n")}\n`;
}

async function pollAi3dTask(endpoint: string, onStatus: (status: string) => void, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint);
    } catch (error) {
      throw new Error(formatRequestError(error, `${label}查询失败`));
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? data.message ?? "Meshy任务查询失败");
    }

    const status = data.status ?? data.state ?? "UNKNOWN";
    const progress = typeof data.progress === "number" ? ` ${Math.round(data.progress * 100)}%` : "";
    onStatus(`${label} ${status}${progress}`);

    if (status === "SUCCEEDED" || status === "succeeded" || status === "COMPLETED") {
      return data;
    }

    if (status === "FAILED" || status === "failed" || status === "CANCELED") {
      throw new Error(data.task_error?.message ?? data.error ?? "Meshy任务失败");
    }

    await new Promise((resolve) => window.setTimeout(resolve, 6000));
  }

  throw new Error(`${label}等待超时`);
}

async function pollV3OrchestratorJob(jobId: string, onUpdate: (job: V3OrchestratorJob) => void) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      throw new Error(formatRequestError(error, "V3 Orchestrator 任务查询失败"));
    }
    const job = await response.json() as V3OrchestratorJob;
    if (!response.ok) {
      throw new Error(job.error ?? "V3 Orchestrator 任务查询失败");
    }
    onUpdate(job);
    if (job.status === "completed") return job;
    if (job.status === "canceled") return job;
    if (job.status === "failed") throw new Error(job.error ?? "V3 Orchestrator 任务失败");
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }

  throw new Error("V3 Orchestrator 任务等待超时");
}

function formatRequestError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const message = error.message || fallback;
  if (/failed to fetch|load failed|networkerror/i.test(message)) {
    return `${fallback}：无法连接本地后端 API。请确认 8787 端口服务已启动，然后刷新页面重试。`;
  }
  return message;
}

function extractDownloadFilename(url: string, fallbackName: string) {
  const clean = url.split("?")[0].split("#")[0];
  const filename = decodeURIComponent(clean.split("/").pop() || "");
  return filename || fallbackName;
}
