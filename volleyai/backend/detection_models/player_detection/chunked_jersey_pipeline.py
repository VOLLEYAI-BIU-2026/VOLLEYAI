import argparse
import json
import os
import shutil
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PREDICT_PIPELINE = os.path.join(SCRIPT_DIR, "predict_pipeline.py")

# Chunk_id offset applied to every track_id a chunk produces, so track_ids
# stay globally unique across chunks once merged -- verified this matters:
# each chunk's ByteTrack instance starts its own track_id counter from
# scratch, so chunk 0's track_id=50 and chunk 1's track_id=50 are two
# unrelated physical people. Without remapping, the merge-safety check in
# mergePlayerRegistry (which assumes track_ids are globally unique) could
# wrongly treat two different real players as the same track, or vice versa.
TRACK_ID_CHUNK_MULTIPLIER = 1_000_000


def parse_args():
    parser = argparse.ArgumentParser(
        description="Runs predict_pipeline.py once per rally-boundary-aligned chunk of a "
                    "long video instead of one continuous pass, then stitches the per-chunk "
                    "frame_jersey_map.json/registry outputs into the same combined-file "
                    "formats a single predict_pipeline.py run would produce -- downstream "
                    "stages (merge_pipeline.py, render_video.py) need no changes at all. "
                    "Verified directly this session: ByteTrack's own tracking quality "
                    "degrades over a long continuous run, tracking noticeably better when "
                    "the identical footage is reprocessed as a short, fresh segment."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--rally-windows", required=True,
                         help="rally_windows.json (from the RALLY stage) -- chunk boundaries "
                              "are cut at dead-time midpoints from this, never mid-rally.")
    parser.add_argument("--frame-jersey-map", required=True, help="final combined output path")
    parser.add_argument("--output-json", required=True, help="final combined registry output path")
    parser.add_argument("--thumbs-dir", required=True, help="final combined thumbnails dir")
    parser.add_argument("--work-dir", default=None, help="scratch dir for per-chunk outputs")
    parser.add_argument("--min-rallies-per-chunk", type=int, default=3,
                         help="target number of rallies per chunk -- smaller chunks stay "
                              "fresher for the tracker but pay more per-chunk model-load "
                              "overhead; larger chunks are the opposite trade-off.")
    # Pass-through args, identical meaning to predict_pipeline.py's own.
    parser.add_argument("--known-jerseys", default="")
    parser.add_argument("--my-team-color", default="blue_white")
    parser.add_argument("--libero-color", default="")
    parser.add_argument("--opponent-color", default="black")
    parser.add_argument("--opponent-libero-color", default="")
    parser.add_argument("--calib-json", default="")
    return parser.parse_args()


def compute_chunks(rally_windows_path, min_rallies_per_chunk):
    with open(rally_windows_path) as f:
        data = json.load(f)
    rally_windows = sorted(data.get("rally_windows", []), key=lambda w: w["start_frame"])
    dead_segments = sorted(data.get("dead_segments", []), key=lambda d: d["start_frame"])
    total_frames = data.get("total_frames")
    last_frame = (total_frames - 1) if total_frames else (
        rally_windows[-1]["end_frame"] + 1000 if rally_windows else -1)

    if not rally_windows:
        # No known rally structure -- one chunk, the whole video. Safe fallback,
        # not the common case (RALLY stage should have produced real windows).
        return [(0, last_frame)]

    def dead_gap_after(end_frame):
        candidates = [d for d in dead_segments if d["start_frame"] >= end_frame]
        return min(candidates, key=lambda d: d["start_frame"]) if candidates else None

    cuts = []
    for i in range(min_rallies_per_chunk - 1, len(rally_windows) - 1, min_rallies_per_chunk):
        gap = dead_gap_after(rally_windows[i]["end_frame"])
        if gap is None:
            continue
        cuts.append((gap["start_frame"] + gap["end_frame"]) // 2)

    chunks = []
    start = 0
    for cut in cuts:
        chunks.append((start, cut))
        start = cut + 1
    chunks.append((start, last_frame))
    return chunks


def run_chunk(args, chunk_idx, start_frame, end_frame, work_dir, bootstrap_path):
    chunk_dir = os.path.join(work_dir, f"chunk_{chunk_idx}")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_thumbs_dir = os.path.join(chunk_dir, "thumbs")
    os.makedirs(chunk_thumbs_dir, exist_ok=True)

    fjm_path = os.path.join(chunk_dir, "frame_jersey_map.json")
    registry_path = os.path.join(chunk_dir, "registry.json")
    video_out_path = os.path.join(chunk_dir, "tracking.mp4")

    cmd = [
        sys.executable, PREDICT_PIPELINE,
        "--video", args.video,
        "--output", video_out_path,
        "--frame-jersey-map", fjm_path,
        "--output-json", registry_path,
        "--thumbs-dir", chunk_thumbs_dir,
        "--start-frame", str(start_frame),
        "--end-frame", str(end_frame),
        "--my-team-color", args.my_team_color,
    ]
    if args.known_jerseys: cmd += ["--known-jerseys", args.known_jerseys]
    if args.libero_color: cmd += ["--libero-color", args.libero_color]
    if args.opponent_color: cmd += ["--opponent-color", args.opponent_color]
    if args.opponent_libero_color: cmd += ["--opponent-libero-color", args.opponent_libero_color]
    if args.calib_json: cmd += ["--calib-json", args.calib_json]

    # Every chunk exports its own end-state (overwriting the same shared
    # path) so the NEXT chunk always imports the immediately-preceding
    # chunk's positions, not a stale snapshot from chunk 0 -- verified
    # directly this mattered: only exporting once from chunk 0 meant chunk 2
    # onward imported positions already 2000+ frames old, well past
    # BRIDGE_MAX_GAP_SEC, so they were discarded before ever bridging
    # anything and the whole carry-over fix was silently a no-op past the
    # first handoff.
    if chunk_idx > 0:
        cmd += ["--import-bootstrap", bootstrap_path]
    cmd += ["--export-bootstrap", bootstrap_path]

    print(f"[CHUNKED] Running chunk {chunk_idx} (frames {start_frame}-{end_frame})...")
    subprocess.run(cmd, check=True)

    frame_jersey_map = {}
    if os.path.exists(fjm_path):
        with open(fjm_path) as f:
            frame_jersey_map = json.load(f)
    registry = {}
    if os.path.exists(registry_path):
        with open(registry_path) as f:
            registry = json.load(f)
    return frame_jersey_map, registry, chunk_thumbs_dir


def remap_track_ids(frame_jersey_map, registry, chunk_idx):
    offset = chunk_idx * TRACK_ID_CHUNK_MULTIPLIER
    for entries in frame_jersey_map.values():
        for e in entries:
            e["track_id"] += offset
    for entry in registry.values():
        entry["track_id"] += offset
    return frame_jersey_map, registry


def merge_frame_jersey_maps(all_maps):
    merged = {}
    for m in all_maps:
        for frame, entries in m.items():
            merged.setdefault(frame, []).extend(entries)
    return merged


def merge_registries(all_registries, final_thumbs_dir):
    # Combine by jersey number -- the real identity across chunks. Each
    # chunk's own registry is keyed however predict_pipeline.py names it
    # (currently the jersey number as a string); track_ids were already
    # remapped to be globally unique by this point.
    by_jersey = {}
    for registry in all_registries:
        for _key, entry in registry.items():
            jersey = entry["jersey"]
            if jersey not in by_jersey:
                by_jersey[jersey] = {
                    "jersey": jersey,
                    "track_ids": [entry["track_id"]],
                    "role": entry["role"],
                    "team": entry["team"],
                    "thumbnail": entry.get("thumbnail"),
                }
            else:
                existing = by_jersey[jersey]
                existing["track_ids"].append(entry["track_id"])
                if not existing.get("thumbnail") and entry.get("thumbnail"):
                    existing["thumbnail"] = entry["thumbnail"]

    final = {}
    for jersey, entry in by_jersey.items():
        dest_thumb = None
        src_thumb = entry.pop("thumbnail", None)
        if src_thumb and os.path.exists(src_thumb):
            dest_thumb = os.path.join(final_thumbs_dir, f"jersey_{jersey}.jpg")
            shutil.copy2(src_thumb, dest_thumb)
        entry["thumbnail"] = dest_thumb
        final[str(jersey)] = entry
    return final


def main():
    args = parse_args()
    work_dir = args.work_dir or os.path.join(
        os.path.dirname(os.path.abspath(args.frame_jersey_map)), "chunked_jersey_work")
    os.makedirs(work_dir, exist_ok=True)
    os.makedirs(args.thumbs_dir, exist_ok=True)

    chunks = compute_chunks(args.rally_windows, args.min_rallies_per_chunk)
    print(f"[CHUNKED] {len(chunks)} chunk(s): {chunks}")

    bootstrap_path = os.path.join(work_dir, "bootstrap.json")
    all_maps, all_registries = [], []
    for i, (start_frame, end_frame) in enumerate(chunks):
        fjm, registry, _chunk_thumbs_dir = run_chunk(
            args, i, start_frame, end_frame, work_dir, bootstrap_path)
        fjm, registry = remap_track_ids(fjm, registry, i)
        all_maps.append(fjm)
        all_registries.append(registry)

    merged_fjm = merge_frame_jersey_maps(all_maps)
    merged_registry = merge_registries(all_registries, args.thumbs_dir)

    os.makedirs(os.path.dirname(os.path.abspath(args.frame_jersey_map)), exist_ok=True)
    with open(args.frame_jersey_map, "w") as f:
        json.dump(merged_fjm, f)
    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w") as f:
        json.dump(merged_registry, f, indent=2)

    print(f"[CHUNKED] Done. {len(merged_fjm)} frames, {len(merged_registry)} players "
          f"-> {args.frame_jersey_map}, {args.output_json}")


if __name__ == "__main__":
    main()
