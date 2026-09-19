#!/usr/bin/env python3
"""Compatibility entry point for the shared native Observer build."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parents[2] / 'src/native/observer/build.py'), run_name='__main__')
