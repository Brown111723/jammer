"""
Jammer analyzer service.

Jobs are queued, not awaited: Demucs takes minutes on CPU, and an HTTP request that
hangs for four minutes will be killed by every proxy between here and the browser. The
client uploads, gets a job id, and polls.

For a single-user local setup the in-process executor here is fine. For anything
multi-user, swap `_EXECUTOR` for Redis + RQ — the interface is deliberately the same
shape.

ON WHAT THIS SERVICE WILL AND WON'T ACCEPT
------------------------------------------
It takes uploaded audio files. It does NOT take URLs, and it should never grow a
"paste a YouTube link" endpoint. That single feature is the line between a tool that
analyses music you own and a stream-ripper, and it is the line most tools in this space
cross. Keep it.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from pipeline import analyze

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("jammer.analyzer")

app = FastAPI(title="Jammer Analyzer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

WORK_ROOT = Path(tempfile.gettempdir()) / "jammer-analyzer"
WORK_ROOT.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
ALLOWED_SUFFIXES = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aiff", ".aif"}

JobStatus = Literal["queued", "running", "done", "failed"]


@dataclass
class Job:
    id: str
    status: JobStatus = "queued"
    progress: float = 0.0
    stage: str = "queued"
    result: dict[str, Any] | None = None
    error: str | None = None
    work_dir: Path | None = field(default=None, repr=False)


_JOBS: dict[str, Job] = {}
# One worker: these stages are already CPU/GPU-saturating, and running two Demucs
# passes concurrently on one machine is slower than running them in sequence.
_EXECUTOR = ThreadPoolExecutor(max_workers=1)


@app.get("/health")
def health() -> dict[str, Any]:
    import torch

    return {
        "ok": True,
        "gpu": torch.cuda.is_available(),
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "note": (
            "Running on CPU — expect several minutes per track for stem separation."
            if not torch.cuda.is_available()
            else "GPU available."
        ),
        "jobs": len(_JOBS),
    }


@app.post("/analyze")
async def submit(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    stems: bool = True,
    tab: bool = True,
) -> dict[str, str]:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            400,
            f"Unsupported file type '{suffix}'. Supported: "
            f"{', '.join(sorted(ALLOWED_SUFFIXES))}",
        )

    job_id = uuid.uuid4().hex
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    dest = work_dir / f"input{suffix}"

    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                shutil.rmtree(work_dir, ignore_errors=True)
                raise HTTPException(
                    413, f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)}MB."
                )
            out.write(chunk)

    job = Job(id=job_id, work_dir=work_dir)
    _JOBS[job_id] = job

    _EXECUTOR.submit(_run, job, dest, stems, tab)
    return {"jobId": job_id}


def _run(job: Job, audio: Path, want_stems: bool, want_tab: bool) -> None:
    job.status = "running"
    try:
        job.stage = "analysing"
        job.progress = 0.1
        result = analyze(
            audio,
            job.work_dir or WORK_ROOT,
            want_stems=want_stems,
            want_tab=want_tab,
        )
        job.result = result.to_dict()
        job.status = "done"
        job.progress = 1.0
        job.stage = "done"
        log.info("job %s finished with %d warnings", job.id, len(result.warnings))
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        job.stage = "failed"
        log.error("job %s failed:\n%s", job.id, traceback.format_exc())
    finally:
        # Stems are large; keep the JSON, drop the audio.
        if job.work_dir:
            shutil.rmtree(job.work_dir / "stems", ignore_errors=True)


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "No such job.")
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "result": job.result,
        "error": job.error,
    }


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> dict[str, bool]:
    job = _JOBS.pop(job_id, None)
    if job and job.work_dir:
        shutil.rmtree(job.work_dir, ignore_errors=True)
    return {"deleted": job is not None}
