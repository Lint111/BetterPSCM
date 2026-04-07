import { describe, it, expect } from 'vitest';
import { normalizePath, wslToWindowsPath } from '../../../src/util/path';

describe('normalizePath', () => {
	it('converts backslashes to forward slashes', () => {
		expect(normalizePath('C:\\Users\\liory\\foo')).toBe('C:/Users/liory/foo');
	});

	it('leaves forward-slash paths unchanged', () => {
		expect(normalizePath('/mnt/c/Users/liory')).toBe('/mnt/c/Users/liory');
	});

	it('handles mixed separators', () => {
		expect(normalizePath('C:\\Users/liory\\foo')).toBe('C:/Users/liory/foo');
	});

	it('handles empty string', () => {
		expect(normalizePath('')).toBe('');
	});
});

describe('wslToWindowsPath', () => {
	it('translates /mnt/c/ to c:/', () => {
		expect(wslToWindowsPath('/mnt/c/Users/liory')).toBe('c:/Users/liory');
	});

	it('translates /mnt/d/ to d:/ (any drive letter)', () => {
		expect(wslToWindowsPath('/mnt/d/projects')).toBe('d:/projects');
	});

	it('lowercases the drive letter for consistency', () => {
		expect(wslToWindowsPath('/mnt/C/Users')).toBe('c:/Users');
	});

	it('handles /mnt/c root without a trailing subpath', () => {
		expect(wslToWindowsPath('/mnt/c')).toBe('c:');
	});

	it('preserves trailing content verbatim', () => {
		expect(wslToWindowsPath('/mnt/c/Users/liory/wkspaces/test')).toBe('c:/Users/liory/wkspaces/test');
	});

	it('leaves Windows paths unchanged', () => {
		expect(wslToWindowsPath('C:/Users/liory')).toBe('C:/Users/liory');
		expect(wslToWindowsPath('c:\\Users\\liory')).toBe('c:\\Users\\liory');
	});

	it('leaves plain Linux paths unchanged', () => {
		expect(wslToWindowsPath('/home/liory/project')).toBe('/home/liory/project');
	});

	it('leaves relative paths unchanged', () => {
		expect(wslToWindowsPath('src/core/cmCli.ts')).toBe('src/core/cmCli.ts');
	});

	it('rejects ambiguous /mnt/ patterns (not a drive letter)', () => {
		expect(wslToWindowsPath('/mnt/data/project')).toBe('/mnt/data/project');
		expect(wslToWindowsPath('/mnt')).toBe('/mnt');
	});
});
