/**
 * vendor.myndhyve.ads-creative-validate — ads.creative.validate executor.
 *
 * Full compliance scanner. Combines text-rule scanning (shared with
 * ads-policy), asset-format checks, and placement text-length checks.
 *
 * Lifted from MyndHyve's AdApprovalGateService.runComplianceChecks
 * (the full flow). PlatformSpecRegistry dependency replaced with
 * caller-supplied `inputs.placementSpecs` + `inputs.placementTextLimits`
 * (workflow author resolves upstream from vendor.myndhyve.ads-platforms
 * pack OR host.adPlatformSpecs).
 *
 * Pure logic, zero host capabilities.
 */

import { AD_POLICY_RULES } from './contentRules.generated.mjs';

function makeLog(ctx) {
  const fn = typeof ctx?.log === 'function' ? ctx.log : null;
  return {
    info: (msg, data) => { if (fn) fn('info', msg, data); },
    debug: (msg, data) => { if (fn) fn('debug', msg, data); },
    warn: (msg, data) => { if (fn) fn('warn', msg, data); },
    error: (msg, data) => { if (fn) fn('error', msg, data); },
  };
}

// ADR 0946 P1 — the ONE rule list, generated from the host content-rules
// library (this pack used to carry a verbatim duplicate of ads-policy's).
const BUILT_IN_RULES = AD_POLICY_RULES;

function evaluateRule(rule, textContent, log) {
  const lowerText = String(textContent).toLowerCase();
  if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
    if (rule.keywords.some((kw) => lowerText.includes(String(kw).toLowerCase()))) {
      return {
        rule: rule.id, category: rule.category,
        status: rule.severity === 'critical' || rule.severity === 'high' ? 'fail' : 'warning',
        message: `${rule.name}: ${rule.recommendation}`,
        autoResolvable: !!rule.autoResolvable,
      };
    }
  }
  if (Array.isArray(rule.patterns) && rule.patterns.length > 0) {
    for (const pattern of rule.patterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(textContent)) {
          return {
            rule: rule.id, category: rule.category,
            status: rule.severity === 'critical' || rule.severity === 'high' ? 'fail' : 'warning',
            message: `${rule.name}: ${rule.recommendation}`,
            autoResolvable: !!rule.autoResolvable,
          };
        }
      } catch (err) {
        log.warn('Invalid regex pattern in rule', { ruleId: rule.id, pattern, error: err?.message });
      }
    }
  }
  return null;
}

function checkAssetFormat(asset, spec) {
  const checks = [];
  if (!spec) return checks;
  if (asset.type === 'image' && spec.imageSpec) {
    if (typeof asset.width === 'number' && typeof asset.height === 'number') {
      if (asset.width < spec.imageSpec.minWidth || asset.height < spec.imageSpec.minHeight) {
        checks.push({
          rule: 'format-image-dimensions', category: 'format', status: 'fail',
          message: `Image dimensions (${asset.width}x${asset.height}) below minimum (${spec.imageSpec.minWidth}x${spec.imageSpec.minHeight}) for ${asset.placement}.`,
          autoResolvable: false,
        });
      }
    }
    if (typeof asset.fileSize === 'number' && typeof spec.imageSpec.maxFileSize === 'number') {
      if (asset.fileSize > spec.imageSpec.maxFileSize) {
        checks.push({
          rule: 'format-image-filesize', category: 'format', status: 'fail',
          message: `Image file size (${Math.round(asset.fileSize / 1024)}KB) exceeds maximum (${Math.round(spec.imageSpec.maxFileSize / 1024)}KB) for ${asset.placement}.`,
          autoResolvable: true,
        });
      }
    }
  }
  if (asset.type === 'video' && spec.videoSpec) {
    if (typeof asset.duration === 'number') {
      if (typeof spec.videoSpec.minDuration === 'number' && asset.duration < spec.videoSpec.minDuration) {
        checks.push({
          rule: 'format-video-duration-min', category: 'format', status: 'fail',
          message: `Video duration (${asset.duration}s) below minimum (${spec.videoSpec.minDuration}s) for ${asset.placement}.`,
          autoResolvable: false,
        });
      }
      if (typeof spec.videoSpec.maxDuration === 'number' && asset.duration > spec.videoSpec.maxDuration) {
        checks.push({
          rule: 'format-video-duration-max', category: 'format', status: 'fail',
          message: `Video duration (${asset.duration}s) exceeds maximum (${spec.videoSpec.maxDuration}s) for ${asset.placement}.`,
          autoResolvable: false,
        });
      }
    }
    if (typeof asset.fileSize === 'number' && typeof spec.videoSpec.maxFileSize === 'number') {
      if (asset.fileSize > spec.videoSpec.maxFileSize) {
        checks.push({
          rule: 'format-video-filesize', category: 'format', status: 'fail',
          message: `Video file size (${Math.round(asset.fileSize / (1024 * 1024))}MB) exceeds maximum (${Math.round(spec.videoSpec.maxFileSize / (1024 * 1024))}MB) for ${asset.placement}.`,
          autoResolvable: false,
        });
      }
    }
  }
  return checks;
}

function checkTextLengths(copyText, placement, limits) {
  if (!limits) return [];
  const checks = [];
  const labels = {
    headline: 'Headline', description: 'Description',
    bodyText: 'Body text', ctaText: 'Call-to-action',
  };
  for (const field of ['headline', 'description', 'bodyText', 'ctaText']) {
    const limit = limits[field];
    const value = copyText[field];
    if (value === undefined || !limit || typeof limit.max !== 'number') continue;
    const length = String(value).length;
    if (typeof limit.min === 'number' && length < limit.min) {
      checks.push({
        rule: `format-text-${placement}`, category: 'format', status: 'fail',
        message: `${labels[field]} must be at least ${limit.min} characters for ${placement} (currently ${length})`,
        autoResolvable: true,
      });
    } else if (length > limit.max) {
      checks.push({
        rule: `format-text-${placement}`, category: 'format', status: 'fail',
        message: `${labels[field]} exceeds the ${limit.max}-character limit for ${placement} (currently ${length})`,
        autoResolvable: true,
      });
    } else if (typeof limit.recommended === 'number' && length > limit.recommended) {
      checks.push({
        rule: `format-text-${placement}`, category: 'format', status: 'warning',
        message: `${labels[field]} exceeds the recommended ${limit.recommended} characters for ${placement}`,
        autoResolvable: true,
      });
    }
  }
  return checks;
}

export async function creativeValidate(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};
  const copyText = inputs.copyText ?? {};
  const assets = Array.isArray(inputs.assets) ? inputs.assets : [];
  const platforms = Array.isArray(inputs.platforms) ? inputs.platforms : [];
  const placements = Array.isArray(inputs.placements) ? inputs.placements : [];
  const customRules = Array.isArray(config.customRules) ? config.customRules : [];
  const allRules = [...BUILT_IN_RULES, ...customRules];

  log.info('Validating creative assets', {
    assetCount: assets.length,
    platforms,
    placements,
  });

  const textContent = [
    copyText.headline,
    copyText.description ?? '',
    copyText.bodyText ?? '',
    copyText.ctaText ?? '',
  ].filter(Boolean).join(' ');

  const checks = [];
  let rulesEvaluated = 0;

  // Text policy rules
  for (const rule of allRules) {
    if (!rule.enabled) continue;
    if (Array.isArray(rule.platforms) && rule.platforms.length > 0
        && !rule.platforms.some((p) => platforms.includes(p))) continue;
    rulesEvaluated++;
    const check = evaluateRule(rule, textContent, log);
    if (check) checks.push(check);
  }

  // Asset format checks
  for (const asset of assets) {
    rulesEvaluated++;
    const spec = inputs.placementSpecs?.[asset.placement];
    checks.push(...checkAssetFormat(asset, spec));
  }

  // Placement text-length checks
  if (inputs.placementTextLimits && typeof inputs.placementTextLimits === 'object') {
    for (const placement of placements) {
      const limits = inputs.placementTextLimits[placement];
      if (!limits) continue;
      rulesEvaluated++;
      checks.push(...checkTextLengths(copyText, placement, limits));
    }
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    warning: checks.filter((c) => c.status === 'warning').length,
  };
  const violations = checks.filter((c) => c.status === 'fail');
  const passed = summary.fail === 0;

  return {
    status: 'success',
    outputs: {
      report: {
        checks,
        passed,
        summary,
        rulesEvaluated,
        scannedAt: new Date().toISOString(),
      },
      isValid: passed,
      violations,
      success: true,
    },
  };
}

export const nodes = {
  'ads.creative.validate': creativeValidate,
};

export default nodes;
