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
import styled from "@emotion/styled";
import ErrorBoundary from "../components/ErrorBoundary";
import Heading from "../components/Heading";

/**
 * https://docs.microsoft.com/en-us/rest/api/azure/devops/build/artifacts/list?view=azure-devops-rest-5.1#artifactresource
 */
interface AzureArtifactResource {
	data: string;
	downloadUrl: string;
	properties: object;
	type: string;
	url: string;
}

/**
 * https://docs.microsoft.com/en-us/rest/api/azure/devops/build/artifacts/get?view=azure-devops-rest-4.1&viewFallbackFrom=azure-devops-rest-5.1#buildartifact
 */
interface AzureBuildArtifact {
	id: string;
	name: string;
	resource: AzureArtifactResource;
}

interface AzureApiBody<Response> {
	value: Response;
	message: unknown;
	typeKey: unknown;
}

interface CircleCIApiArtifacts {
	items: ReadonlyArray<{ path: string; url: string }>;
}

interface SizeSnapshot {
	[bundleId: string]: { parsed: number; gzip: number };
}

async function fetchSizeSnapshotAzure(buildId: number): Promise<SizeSnapshot> {
	const response = await fetch(
		`https://dev.azure.com/mui-org/material-ui/_apis/build/builds/${buildId}/artifacts?api-version=5.1`
	);

	const body: AzureApiBody<AzureBuildArtifact[]> = await response.json();

	if (response.status === 200) {
		const artifacts = body.value;
		const artifact = artifacts.find(
			(artifact) => artifact.name === "size-snapshot"
		);

		const downloadUrl = new URL(artifact!.resource.downloadUrl);
		downloadUrl.searchParams.set("format", "file");
		downloadUrl.searchParams.set("subPath", "/size-snapshot.json");
		return downloadSnapshot("size-snapshot-azure", downloadUrl.toString());
	}

	throw new Error(`${body.typeKey}: ${body.message}`);
}

async function fetchSizeSnapshotCircleCI(
	buildNumber: number
): Promise<SizeSnapshot> {
	const response = await fetch(
		`https://circleci.com/api/v2/project/gh/mui/material-ui/${buildNumber}/artifacts`
	);
	const body: CircleCIApiArtifacts = await response.json();

	if (response.status === 200) {
		const artifacts = body.items;
		const artifact = artifacts.find(
			(artifact) => artifact.path === "size-snapshot.json"
		);

		const downloadURL = new URL(
			"/.netlify/functions/test-profile-artifact",
			document.baseURI
		);
		downloadURL.searchParams.set("url", artifact!.url);

		return downloadSnapshot("size-snapshot-circleci", downloadURL.toString());
	}

	throw new Error(`${response.status}: ${response.statusText}`);
}

async function fetchSizeSnapshot(
	key: unknown,
	{
		azureBuildId,
		circleCIBuildNumber,
	}: { azureBuildId: number; circleCIBuildNumber: number }
): Promise<SizeSnapshot | undefined> {
	if (azureBuildId) {
		return fetchSizeSnapshotAzure(azureBuildId);
	}
	return fetchSizeSnapshotCircleCI(circleCIBuildNumber);
}

async function downloadSnapshot(
	key: unknown,
	downloadUrl: string
): Promise<SizeSnapshot> {
	const response = await fetch(downloadUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch "${downloadUrl}", HTTP ${response.status}`
		);
	}
	return response.json();
}

function useAzureSizeSnapshot({
	azureBuildId,
	circleCIBuildNumber,
}: {
	azureBuildId: number;
	circleCIBuildNumber: number;
}): SizeSnapshot {
	const { data: sizeSnapshot } = useQuery(
		[
			"azure-artifacts",
			{
				azureBuildId,
				circleCIBuildNumber,
			},
		],
		fetchSizeSnapshot
	);

	// NonNullable due to Suspense
	return sizeSnapshot!;
}

function useS3SizeSnapshot(ref: string, commitId: string): SizeSnapshot {
	const artifactServer = "https://s3.eu-central-1.amazonaws.com/mui-org-ci";
	const downloadUrl = `${artifactServer}/artifacts/${ref}/${commitId}/size-snapshot.json`;

	const { data: sizeSnapshot } = useQuery(
		["s3-snapshot-download", downloadUrl],
		downloadSnapshot
	);

	// NonNullable due to Suspense
	return sizeSnapshot!;
}

/**
 * Generates a user-readable string from a percentage change
 * @param change
 * @param goodEmoji emoji on reduction
 * @param badEmoji emoji on increase
 */
function addPercent(
	change: number,
	goodEmoji: string = "",
	badEmoji: string = ":small_red_triangle:"
): string {
	const formatted = (change * 100).toFixed(2);
	if (/^-|^0(?:\.0+)$/.test(formatted)) {
		return `${formatted}% ${goodEmoji}`;
	}
	return `+${formatted}% ${badEmoji}`;
}

function formatDiff(absoluteChange: number, relativeChange: number): string {
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
}: {
	entries: [string, Size][];
	getBundleLabel: (bundleId: string) => string;
	renderBundleLabel?: (bundleId: string) => string;
}) {
	const rows = useMemo(() => {
		return (
			entries
				.map(([bundleId, size]): [string, Size & { id: string }] => [
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

function getMainBundleLabel(bundleId: string): string {
	if (bundleId === "@material-ui/core/Textarea") {
		return "TextareaAutosize";
	}
	if (bundleId === "docs.main") {
		return "docs:/_app";
	}
	if (bundleId === "docs.landing") {
		return "docs:/";
	}
	console.log(bundleId);
	return (
		bundleId
			// package renames
			.replace(/^@material-ui\/core$/, "@mui/material")
			.replace(/^@material-ui\/core.legacy$/, "@mui/material.legacy")
			.replace(/^@material-ui\/icons$/, "@mui/material-icons")
			.replace(/^@material-ui\/unstyled$/, "@mui/core")
			// org rename
			.replace(/^@material-ui\/([\w-]+)$/, "@mui/$1")
			// path renames
			.replace(
				/^packages\/material-ui\/material-ui\.production\.min\.js$/,
				"packages/mui-material/material-ui.production.min.js"
			)
			.replace(/^@material-ui\/core\//, "")
			.replace(/\.esm$/, "")
	);
}

function getPageBundleLabel(bundleId: string): string {
	// a page
	if (bundleId.startsWith("docs:/")) {
		const page = bundleId.replace(/^docs:/, "");
		return page;
	}

	// shared
	return bundleId;
}

interface Size {
	parsed: {
		previous: number;
		current: number;
		absoluteDiff: number;
		relativeDiff: number;
	};
	gzip: {
		previous: number;
		current: number;
		absoluteDiff: number;
		relativeDiff: number;
	};
}

const nullSnapshot = { parsed: 0, gzip: 0 };
function Comparison({
	baseRef,
	baseCommit,
	buildId,
	circleCIBuildNumber,
	prNumber,
}: {
	baseRef: string;
	baseCommit: string;
	buildId: number;
	circleCIBuildNumber: number;
	prNumber: number;
}) {
	const baseSnapshot = useS3SizeSnapshot(baseRef, baseCommit);
	const targetSnapshot = useAzureSizeSnapshot({
		azureBuildId: buildId,
		circleCIBuildNumber,
	});

	const { main: mainResults, pages: pageResults } = useMemo(() => {
		const bundleKeys = Object.keys({ ...baseSnapshot, ...targetSnapshot });

		const main: [string, Size][] = [];
		const pages: [string, Size][] = [];
		bundleKeys.forEach((bundle) => {
			// current vs previous based off: https://github.com/mui/material-ui/blob/f1246e829f9c0fc9458ce951451f43c2f166c7d1/scripts/sizeSnapshot/loadComparison.js#L32
			// if a bundle was added the change should be +inf
			// if a bundle was removed the change should be -100%
			const currentSize = targetSnapshot[bundle] || nullSnapshot;
			const previousSize = baseSnapshot[bundle] || nullSnapshot;

			const entry: [string, Size] = [
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
			baseCommit: params.get("baseCommit")!,
			baseRef: params.get("baseRef")!,
			buildId: +params.get("buildId")!,
			prNumber: +params.get("prNumber")!,
			circleCIBuildNumber: +params.get("circleCIBuildNumber")!,
		};
	}, [search]);
}

function ComparisonErrorFallback({ prNumber }: { prNumber: number }) {
	return (
		<p>
			Could not load comparison for{" "}
			<Link href={`https://github.com/mui/material-ui/pull/${prNumber}`}>
				#{prNumber}
			</Link>
			. This can happen if the build in the CI job didn't finish yet.{" "}
			<Link href="">Reload this page</Link> once the CI job has finished.
		</p>
	);
}

export default function SizeComparison() {
	const { buildId, baseRef, baseCommit, circleCIBuildNumber, prNumber } =
		useComparisonParams();

	return (
		<Fragment>
			<Heading level="1">Size comparison</Heading>
			<Suspense
				fallback={
					<p>
						Loading comparison for build{" "}
						<em>{buildId || circleCIBuildNumber}</em>
					</p>
				}
			>
				<ErrorBoundary
					fallback={<ComparisonErrorFallback prNumber={prNumber} />}
				>
					<Comparison
						buildId={buildId}
						baseRef={baseRef}
						baseCommit={baseCommit}
						circleCIBuildNumber={circleCIBuildNumber}
						prNumber={prNumber}
					/>
				</ErrorBoundary>
			</Suspense>
		</Fragment>
	);
}
