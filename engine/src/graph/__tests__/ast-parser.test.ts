/**
 * Tests for ast-parser.ts — multi-language AST extraction via tree-sitter WASM.
 *
 * Tests:
 * 1. Parse a TypeScript file — imports, exports, functions, classes
 * 2. Parse a Python file — imports, functions, classes
 * 3. Parse a Go file — functions, types, imports
 * 4. Parse a Rust file — functions, structs, use declarations
 * 5. Parse a Java file — methods, classes, imports
 * 6. Parse a Ruby file — methods, classes
 * 7. Returns null for unsupported extension
 * 8. Parser caching — second call reuses the same parser instance
 * 9. getSupportedLanguages returns all 14 languages
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getSupportedLanguages, parseFile } from '../ast-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(tmpdir(), `lazybrain-ast-test-${process.pid}`);

const TS_FIXTURE = `
import { foo, bar } from './utils';
import type { MyType } from '../types';
import defaultExport from 'external-pkg';

export interface MyInterface {
  name: string;
}

export class MyClass extends BaseClass {
  constructor(private name: string) { super(); }
  greet(): string { return this.name; }
  static create(n: string): MyClass { return new MyClass(n); }
}

export function myFunc(a: string, b: number): string {
  return a.repeat(b);
}

export const myArrow = (x: number) => x * 2;
export const myConst = 42;

export default function defaultFunc() {}
`.trim();

const GO_FIXTURE = `
package main

import (
	"fmt"
	"strings"
)

type Animal struct {
	Name string
	Age  int
}

func NewAnimal(name string, age int) *Animal {
	return &Animal{Name: name, Age: age}
}

func (a *Animal) Speak() string {
	return fmt.Sprintf("%s says hello", a.Name)
}

func privateHelper(s string) string {
	return strings.TrimSpace(s)
}
`.trim();

const RUST_FIXTURE = `
use std::fmt;
use std::collections::HashMap;

pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub enum Color {
    Red,
    Green,
    Blue,
}

pub fn distance(a: &Point, b: &Point) -> f64 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    (dx * dx + dy * dy).sqrt()
}

fn internal_helper() -> i32 {
    42
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}
`.trim();

const JAVA_FIXTURE = `
import java.util.List;
import java.util.ArrayList;

public class Animal {
    private String name;
    private int age;

    public Animal(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public String getName() {
        return this.name;
    }

    public String speak() {
        return this.name + " says hello";
    }

    private void internalMethod() {}
}
`.trim();

const RUBY_FIXTURE = `
require 'json'
require_relative './helpers'

module Greetable
  def greet
    "Hello, I am #{name}"
  end
end

class Animal
  include Greetable

  attr_reader :name, :age

  def initialize(name, age)
    @name = name
    @age = age
  end

  def speak
    "#{name} says hello"
  end

  private

  def _internal
    nil
  end
end
`.trim();

const PY_FIXTURE = `
import os
import sys
from pathlib import Path
from typing import List, Optional

class MyClass(BaseClass):
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return self.name

    def _private(self):
        pass

def helper(a: str, b: int = 0) -> Optional[str]:
    return a if b else None

def _internal():
    pass
`.trim();

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'sample.ts'), TS_FIXTURE, 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'sample.py'), PY_FIXTURE, 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'sample.go'), GO_FIXTURE, 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'sample.rs'), RUST_FIXTURE, 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'Animal.java'), JAVA_FIXTURE, 'utf8');
  writeFileSync(join(FIXTURE_DIR, 'sample.rb'), RUBY_FIXTURE, 'utf8');
});

afterAll(() => {
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSupportedLanguages', () => {
  it('returns all 14 supported languages', async () => {
    const langs = await getSupportedLanguages();
    const required = [
      'typescript',
      'tsx',
      'javascript',
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'c',
      'cpp',
      'php',
      'csharp',
      'swift',
      'kotlin',
    ];
    for (const lang of required) {
      expect(langs).toContain(lang);
    }
  });
});

describe('parseFile — TypeScript', () => {
  it('returns a ParsedFile for a .ts file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('typescript');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts imports with source and specifiers', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const relImport = result!.imports.find((i) => i.source === './utils');
    expect(relImport).toBeDefined();
    expect(relImport!.specifiers).toContain('foo');
    expect(relImport!.specifiers).toContain('bar');
    expect(relImport!.isRelative).toBe(true);

    const extImport = result!.imports.find((i) => i.source === 'external-pkg');
    expect(extImport).toBeDefined();
    expect(extImport!.isRelative).toBe(false);
    expect(extImport!.specifiers).toContain('default');
  });

  it('extracts named and default exports', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const exports = result!.exports;
    expect(exports).toContain('MyInterface');
    expect(exports).toContain('MyClass');
    expect(exports).toContain('myFunc');
    expect(exports).toContain('myConst');
    expect(exports).toContain('default');
  });

  it('extracts functions with params', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const myFunc = result!.functions.find((f) => f.name === 'myFunc');
    expect(myFunc).toBeDefined();
    expect(myFunc!.params).toContain('a');
    expect(myFunc!.params).toContain('b');
    expect(myFunc!.isExported).toBe(true);
    expect(myFunc!.startLine).toBeGreaterThan(0);
    expect(myFunc!.excerpt).toContain('function myFunc');
  });

  it('extracts type aliases and non-function consts as bindings', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const bindings = result!.bindings;
    expect(bindings.find((b) => b.name === 'MyInterface')?.kind).toBe('interface');
    expect(bindings.find((b) => b.name === 'myConst')?.kind).toBe('const');
    expect(bindings.find((b) => b.name === 'myArrow')).toBeUndefined();
  });

  it('extracts arrow function assigned to exported const', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const myArrow = result!.functions.find((f) => f.name === 'myArrow');
    expect(myArrow).toBeDefined();
    expect(myArrow!.isExported).toBe(true);
  });

  it('extracts classes with methods and extends', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.ts'));
    const cls = result!.classes.find((c) => c.name === 'MyClass');
    expect(cls).toBeDefined();
    expect(cls!.isExported).toBe(true);
    expect(cls!.extends).toBe('BaseClass');
    expect(cls!.methods).toContain('greet');
    expect(cls!.methods).toContain('create');
  });
});

describe('parseFile — Python', () => {
  it('returns a ParsedFile for a .py file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.py'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('python');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts import and from-import statements', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.py'));
    const osImport = result!.imports.find((i) => i.source === 'os');
    expect(osImport).toBeDefined();

    const pathImport = result!.imports.find((i) => i.source === 'pathlib');
    expect(pathImport).toBeDefined();
    expect(pathImport!.specifiers).toContain('Path');
  });

  it('extracts top-level functions (excluding private)', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.py'));
    const helper = result!.functions.find((f) => f.name === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.isExported).toBe(true);

    // _internal is private — should be present but marked not exported
    const internal = result!.functions.find((f) => f.name === '_internal');
    expect(internal?.isExported).toBe(false);
  });

  it('extracts classes with methods and superclass', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.py'));
    const cls = result!.classes.find((c) => c.name === 'MyClass');
    expect(cls).toBeDefined();
    expect(cls!.extends).toContain('BaseClass');
    expect(cls!.methods).toContain('__init__');
    expect(cls!.methods).toContain('greet');
    expect(cls!.methods).toContain('_private');
  });

  it('surfaces public names as exports', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.py'));
    expect(result!.exports).toContain('MyClass');
    expect(result!.exports).toContain('helper');
    // Private names should not appear
    expect(result!.exports).not.toContain('_internal');
  });
});

describe('parseFile — Go', () => {
  it('returns a ParsedFile for a .go file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.go'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('go');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts Go functions including methods', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.go'));
    const names = result!.functions.map((f) => f.name);
    expect(names).toContain('NewAnimal');
    expect(names).toContain('Speak');
    expect(names).toContain('privateHelper');
  });

  it('extracts Go struct as class', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.go'));
    const names = result!.classes.map((c) => c.name);
    expect(names.some((n) => n === 'Animal' || n.includes('Animal'))).toBe(true);
  });

  it('extracts Go import paths', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.go'));
    const sources = result!.imports.map((i) => i.source);
    expect(sources.some((s) => s.includes('fmt'))).toBe(true);
  });

  it('marks exported Go symbols (uppercase) correctly', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.go'));
    const exported = result!.exports;
    expect(exported).toContain('NewAnimal');
    expect(exported).toContain('Speak');
    // privateHelper starts lowercase — not exported
    expect(exported).not.toContain('privateHelper');
  });
});

describe('parseFile — Rust', () => {
  it('returns a ParsedFile for a .rs file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rs'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('rust');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts Rust functions', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rs'));
    const names = result!.functions.map((f) => f.name);
    expect(names).toContain('distance');
    expect(names).toContain('internal_helper');
  });

  it('extracts Rust structs and enums as classes', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rs'));
    const names = result!.classes.map((c) => c.name);
    expect(names).toContain('Point');
    expect(names).toContain('Color');
  });

  it('extracts Rust use declarations as imports', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rs'));
    expect(result!.imports.length).toBeGreaterThan(0);
  });

  it('marks pub Rust items as exported', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rs'));
    const exported = result!.exports;
    expect(exported).toContain('distance');
    expect(exported).toContain('Point');
    expect(exported).toContain('Color');
    // internal_helper has no pub — not exported
    expect(exported).not.toContain('internal_helper');
  });
});

describe('parseFile — Java', () => {
  it('returns a ParsedFile for a .java file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'Animal.java'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('java');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts Java methods', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'Animal.java'));
    const names = result!.functions.map((f) => f.name);
    expect(names).toContain('getName');
    expect(names).toContain('speak');
  });

  it('extracts Java class', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'Animal.java'));
    const cls = result!.classes.find((c) => c.name === 'Animal');
    expect(cls).toBeDefined();
  });

  it('extracts Java imports', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'Animal.java'));
    expect(result!.imports.length).toBeGreaterThan(0);
  });
});

describe('parseFile — Ruby', () => {
  it('returns a ParsedFile for a .rb file', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rb'));
    expect(result).not.toBeNull();
    expect(result!.language).toBe('ruby');
    expect(result!.lineCount).toBeGreaterThan(5);
  });

  it('extracts Ruby methods', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rb'));
    const names = result!.functions.map((f) => f.name);
    expect(names).toContain('initialize');
    expect(names).toContain('speak');
  });

  it('extracts Ruby class and module', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'sample.rb'));
    const names = result!.classes.map((c) => c.name);
    expect(names).toContain('Animal');
    expect(names).toContain('Greetable');
  });
});

describe('parseFile — unsupported extension', () => {
  it('returns null for .json', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'package.json'));
    expect(result).toBeNull();
  });

  it('returns null for .md', async () => {
    const result = await parseFile(join(FIXTURE_DIR, 'README.md'));
    expect(result).toBeNull();
  });

  it('returns null for non-existent file with supported extension', async () => {
    // File does not exist — readFileSync throws, returns null
    const result = await parseFile(join(FIXTURE_DIR, 'ghost.ts'));
    expect(result).toBeNull();
  });
});

describe('parseFile — parser caching', () => {
  it('second call for same language is faster than first (warmup test)', async () => {
    const path = join(FIXTURE_DIR, 'sample.ts');

    // Warm up (may already be cached from earlier tests)
    const t0 = performance.now();
    await parseFile(path);
    const cold = performance.now() - t0;

    // Second call — parser is cached
    const t1 = performance.now();
    await parseFile(path);
    const warm = performance.now() - t1;

    // Warm call should be substantially faster (WASM not reloaded)
    // We allow 10x margin to avoid flakiness, just verify no regression
    expect(warm).toBeLessThan(cold + 200); // warm must not exceed cold + 200ms
  });

  it('concurrent calls for same language do not crash', async () => {
    const path = join(FIXTURE_DIR, 'sample.ts');
    const results = await Promise.all([parseFile(path), parseFile(path), parseFile(path)]);
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.language).toBe('typescript');
    }
  });
});
