import { Fragment, memo, useCallback, useMemo, Suspense } from "react";
import { useLocation } from "react-router";
import { useQuery } from "react-query";
import Accordion from "@material-ui/core/Accordion";
import AccordionDetails from "@material-ui/core/AccordionDetails";
import AccordionSummary from "@material-ui/core/AccordionSummary";
import Link from "@material-ui/core/Link";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import prettyBytes from "pretty-bytes";
import styled from "styled-components";
import ErrorBoundary from "../components/ErrorBoundary";
import Heading from "../components/Heading";

async function fetchArtifact(key, { buildId, artifactName }) {
	const response = await fetch(
		`https://dev.azure.com/mui-org/material-ui/_apis/build/builds/${buildId}/artifacts?api-version=5.1`
	);

	const body = await response.json();

	if (response.status === 200) {
		const artifacts = body.value;
		return artifacts.find((artifact) => artifact.name === artifactName);
	}

	throw new Error(`${body.typeKey}: ${body.message}`);
}

function downloadSnapshot(key, downloadUrl) {
	return fetch(downloadUrl)
		.then((response) => {
			return response.json();
		})
		.then((snapshot) => {
			return snapshot;
		});
}

function useAzureSizeSnapshot(buildId) {
	const { data: snapshotArtifact } = useQuery(
		[
			"azure-artifacts",
			{
				artifactName: "size-snapshot",
				buildId,
			},
		],
		fetchArtifact
	);

	const downloadUrl = new URL(snapshotArtifact.resource.downloadUrl);
	downloadUrl.searchParams.set("format", "file");
	downloadUrl.searchParams.set("subPath", "/size-snapshot.json");
	const { data: sizeSnapshot } = useQuery(
		["azure-snapshot-download", downloadUrl],
		downloadSnapshot
	);

	return sizeSnapshot;
}

function useS3SizeSnapshot(ref, commitId) {
	const artifactServer =
		"https://s3.eu-central-1.amazonaws.com/eps1lon-material-ui";

	const downloadUrl = `${artifactServer}/artifacts/${ref}/${commitId}/size-snapshot.json`;
	const { data: sizeSnapshot } = useQuery(
		["s3-snapshot-download", downloadUrl],
		downloadSnapshot
	);

	return sizeSnapshot;
}

/**
 * Generates a user-readable string from a percentage change
 * @param {number} change
 * @param {string} goodEmoji emoji on reduction
 * @param {string} badEmoji emoji on increase
 */
function addPercent(change, goodEmoji = "", badEmoji = ":small_red_triangle:") {
	const formatted = (change * 100).toFixed(2);
	if (/^-|^0(?:\.0+)$/.test(formatted)) {
		return `${formatted}% ${goodEmoji}`;
	}
	return `+${formatted}% ${badEmoji}`;
}

function formatDiff(absoluteChange, relativeChange) {
	if (absoluteChange === 0) {
		return "--";
	}

	const trendIcon = absoluteChange < 0 ? "▼" : "▲";

	return `${trendIcon} ${prettyBytes(absoluteChange, {
		signed: true,
	})} (${addPercent(relativeChange, "", "")})`;
}

const BundleCell = styled(TableCell)`
	max-width: 40ch;
`;

const CompareTable = memo(function CompareTable({
	entries,
	getBundleLabel,
	renderBundleLabel = getBundleLabel,
}) {
	const rows = useMemo(() => {
		return (
			entries
				.map(([bundleId, size]) => [
					getBundleLabel(bundleId),
					{ ...size, id: bundleId },
				])
				// orderBy(|parsedDiff| DESC, |gzipDiff| DESC, name ASC)
				.sort(([labelA, statsA], [labelB, statsB]) => {
					const compareParsedDiff =
						Math.abs(statsB.parsed.absoluteDiff) -
						Math.abs(statsA.parsed.absoluteDiff);
					const compareGzipDiff =
						Math.abs(statsB.gzip.absoluteDiff) -
						Math.abs(statsA.gzip.absoluteDiff);
					const compareName = labelA.localeCompare(labelB);

					if (compareParsedDiff === 0 && compareGzipDiff === 0) {
						return compareName;
					}
					if (compareParsedDiff === 0) {
						return compareGzipDiff;
					}
					return compareParsedDiff;
				})
		);
	}, [entries, getBundleLabel]);

	return (
		<Table>
			<TableHead>
				<TableRow>
					<BundleCell>bundle</BundleCell>
					<TableCell align="right">Size change</TableCell>
					<TableCell align="right">Size</TableCell>
					<TableCell align="right">Gzip change</TableCell>
					<TableCell align="right">Gzip</TableCell>
				</TableRow>
			</TableHead>
			<TableBody>
				{rows.map(([label, { parsed, gzip, id }]) => {
					return (
						<TableRow key={label}>
							<BundleCell>{renderBundleLabel(id)}</BundleCell>
							<TableCell align="right">
								{formatDiff(parsed.absoluteDiff, parsed.relativeDiff)}
							</TableCell>
							<TableCell align="right">{prettyBytes(parsed.current)}</TableCell>
							<TableCell align="right">
								{formatDiff(gzip.absoluteDiff, gzip.relativeDiff)}
							</TableCell>
							<TableCell align="right">{prettyBytes(gzip.current)}</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
});

function getMainBundleLabel(bundleId) {
	if (
		bundleId === "packages/material-ui/build/umd/material-ui.production.min.js"
	) {
		return "@material-ui/core[umd]";
	}
	if (bundleId === "@material-ui/core/Textarea") {
		return "TextareaAutosize";
	}
	if (bundleId === "docs.main") {
		return "docs:/_app";
	}
	if (bundleId === "docs.landing") {
		return "docs:/";
	}
	return bundleId.replace(/^@material-ui\/core\//, "").replace(/\.esm$/, "");
}

function getPageBundleLabel(bundleId) {
	// a page
	if (bundleId.startsWith("docs:/")) {
		const page = bundleId.replace(/^docs:/, "");
		return page;
	}

	// shared
	return bundleId;
}

const nullSnapshot = { parsed: 0, gzip: 0 };
function Comparison({ baseRef, baseCommit, buildId, prNumber }) {
	const baseSnapshot = useS3SizeSnapshot(baseRef, baseCommit);
	const targetSnapshot = useAzureSizeSnapshot(buildId);

	const { main: mainResults, pages: pageResults } = useMemo(() => {
		const bundleKeys = Object.keys({ ...baseSnapshot, ...targetSnapshot });

		const main = [];
		const pages = [];
		bundleKeys.forEach((bundle) => {
			// current vs previous based off: https://github.com/mui-org/material-ui/blob/f1246e829f9c0fc9458ce951451f43c2f166c7d1/scripts/sizeSnapshot/loadComparison.js#L32
			// if a bundle was added the change should be +inf
			// if a bundle was removed the change should be -100%
			const currentSize = targetSnapshot[bundle] || nullSnapshot;
			const previousSize = baseSnapshot[bundle] || nullSnapshot;

			const entry = [
				bundle,
				{
					parsed: {
						previous: previousSize.parsed,
						current: currentSize.parsed,
						absoluteDiff: currentSize.parsed - previousSize.parsed,
						relativeDiff: currentSize.parsed / previousSize.parsed - 1,
					},
					gzip: {
						previous: previousSize.gzip,
						current: currentSize.gzip,
						absoluteDiff: currentSize.gzip - previousSize.gzip,
						relativeDiff: currentSize.gzip / previousSize.gzip - 1,
					},
				},
			];

			if (bundle.startsWith("docs:")) {
				pages.push(entry);
			} else {
				main.push(entry);
			}
		});

		return { main, pages };
	}, [baseSnapshot, targetSnapshot]);

	const renderPageBundleLabel = useCallback(
		(bundleId) => {
			// a page
			if (bundleId.startsWith("docs:/")) {
				const page = bundleId.replace(/^docs:/, "");
				const host = `https://deploy-preview-${prNumber}--material-ui.netlify.app`;
				return <Link href={`${host}${page}`}>{page}</Link>;
			}

			// shared
			return bundleId;
		},
		[prNumber]
	);

	return (
		<Fragment>
			<Accordion defaultExpanded={true}>
				<AccordionSummary>Modules</AccordionSummary>
				<AccordionDetails>
					<CompareTable
						entries={mainResults}
						getBundleLabel={getMainBundleLabel}
					/>
				</AccordionDetails>
			</Accordion>
			<Accordion defaultExpanded={false}>
				<AccordionSummary>Pages</AccordionSummary>
				<AccordionDetails>
					<CompareTable
						entries={pageResults}
						getBundleLabel={getPageBundleLabel}
						renderBundleLabel={renderPageBundleLabel}
					/>
				</AccordionDetails>
			</Accordion>
		</Fragment>
	);
}

function useComparisonParams() {
	const { search } = useLocation();
	return useMemo(() => {
		const params = new URLSearchParams(search);

		return {
			baseCommit: params.get("baseCommit"),
			baseRef: params.get("baseRef"),
			buildId: +params.get("buildId"),
			prNumber: +params.get("prNumber"),
		};
	}, [search]);
}

function ComparisonErrorFallback({ prNumber }) {
	return (
		<p>
			Could not load comparison for{" "}
			<Link href={`https://github.com/mui-org/material-ui/pull/${prNumber}`}>
				#{prNumber}
			</Link>
			. This can happen if the build in the Azure Pipeline didn't finish yet.{" "}
			<Link href="">Reload this page</Link> once the Azure build has finished.
		</p>
	);
}

export default function SizeComparison() {
	const { buildId, baseRef, baseCommit, prNumber } = useComparisonParams();

	return (
		<Fragment>
			<Heading level="1">Size comparison</Heading>
			<Suspense
				fallback={
					<p>
						Loading comparison for build <em>{buildId}</em>
					</p>
				}
			>
				<ErrorBoundary
					fallback={
						<ComparisonErrorFallback
							buildId={buildId}
							baseRef={baseRef}
							baseCommit={baseCommit}
							prNumber={prNumber}
						/>
					}
				>
					<Comparison
						buildId={buildId}
						baseRef={baseRef}
						baseCommit={baseCommit}
						prNumber={prNumber}
					/>
				</ErrorBoundary>
			</Suspense>
		</Fragment>
	);
}
