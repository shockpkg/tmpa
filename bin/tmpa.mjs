#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {Manager} from '@shockpkg/core';

const chars = (new Array(16)).fill(0).map((_, i) => i.toString(16));

async function exec(cmd, args = [], env = {}) {
	const code = await new Promise((resolve, reject) => {
		const p = spawn(cmd, args, {
			stdio: 'inherit',
			env: {...process.env, ...env}
		});
		p.once('close', resolve);
		p.once('error', reject);
	});
	if (code) {
		throw new Error(`Exit code: ${code}`);
	}
}

function suff() {
	return new Date().toISOString().replace(/(-|T.*)/g, '');
}

async function getAI(bucket) {
	const url = `https://archive.org/metadata/${bucket}/`;
	const res = await fetch(url);
	if (res.status !== 200) {
		throw new Error(`Bad status: ${res.status}`);
	}
	const json = await res.json();
	const r = new Map();
	if (json && json.files) {
		for (const f of json.files) {
			const path = f.name.split('/');
			if (path.length === 2 && /^[0-9a-f]{64}$/.test(path[0])) {
				r.set(path[0], path[1]);
			}
		}
	}
	return r;
}

async function exists(bucket, path) {
	const url = `https://archive.org/download/${bucket}/${path}`;
	const res = await fetch(url, {
		method: 'HEAD'
	});
	return res.status !== 404;
}

async function main() {
	const args = process.argv.slice(2);

	const groups = new Map();
	for (const a of args) {
		const [group, bucket] = a.split('=');
		groups.set(group, bucket || `${group}-${suff()}`);
	}

	const manager = new Manager();

	let downloading = null;
	let prevPercent = null;
	manager.eventPackageDownloadBefore.on(e => {
		downloading = e.package;
		prevPercent = null;
	});
	manager.eventPackageDownloadProgress.on(e => {
		const per = `${Math.floor((e.amount / downloading.size) * 100)}%`;
		if (per !== prevPercent) {
			prevPercent = per;
			process.stdout.write(`\r${per}`);
		}
	});
	manager.eventPackageDownloadAfter.on(e => {
		downloading = null;
		prevPercent = null;
		console.log('');
	});

	await manager.update();

	let failures = 0;
	for (const [group, bucket] of groups) {
		const mirrored = await getAI(bucket);
		console.log(`Mirrored ${bucket}: ${mirrored.size}`);

		for await (const pkg of manager.packages()) {
			// Skip the child package for now.
			if (pkg.parent) {
				continue;
			}

			// Only those in group.
			if (
				pkg.name !== group &&
				!pkg.name.startsWith(`${group}-`)
			) {
				continue;
			}

			if (mirrored.has(pkg.sha256)) {
				continue;
			}

			// Remap hack:
			for (const c of chars) {
				const BUCKET = process.env[`BUCKET_${c.toUpperCase()}`];
				if (!BUCKET) {
					continue;
				}
				pkg.source = pkg.source.replaceAll(
					`https://archive.org/download/shockpkg_packages_${c}/`,
					BUCKET
				);
			}

			console.log(pkg.name);
			const path = `${pkg.sha256}/${pkg.file}`;
			console.log(`${bucket}/${path}`);
			console.log('Downloading:');
			try {
				await manager.install(pkg);
			}
			catch (err) {
				failures++;
				console.log('Skip');
				console.error(err);
				console.log('.');

				console.log('.');
				console.log('.');
				console.log('.');
				continue;
			}
			console.log('Downloaded');
			console.log('.');

			console.log('Uploading:');
			console.log(`${bucket}/${path}`);
			const installed = await manager.file(pkg);
			console.log(installed);
			console.log('.');
			const argv = [
				'./bin/backup',
				'backup.ini',
				installed,
				bucket,
				path
			];
			await exec(argv[0], argv.slice(1));
			console.log('Uploaded:');
			console.log(`${bucket}/${path}`);
			console.log('.');

			console.log('Removing:');
			console.log(installed);
			await manager.remove(pkg);
			console.log('Removed');
			console.log('.');

			console.log('.');
			console.log('.');
			console.log('.');
		}
	}

	console.log(failures ? `Errors: ${failures}` : 'Done');
	return failures ? 1 : 0;
}
main().then(
	code => {
		process.exitCode = code;
	},
	err => {
		console.error(err);
		process.exitCode = 1;
	}
);
