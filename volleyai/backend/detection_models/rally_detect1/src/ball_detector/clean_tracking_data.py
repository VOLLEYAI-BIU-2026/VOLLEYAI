# src/ball_detector/clean_tracking_data.py

import pandas as pd
import numpy as np



def clean_noise(tracking_csv, output_csv):
    """
    Filters noisy tracking data and resolves temporal overlaps to produce a clean single-object trajectory.

    The function performs a four-stage cleaning process:
    1. Statistics Calculation: Aggregates track duration, confidence, and Euclidean displacement.
    2. Hard Filtering: Removes tracks that are static (displacement < 20px), very short 
       (flickers), or consistently low confidence.
    3. Overlap Resolution: For frames with multiple valid detections, selects the track 
       with the highest 'quality_score' (Duration * Confidence * Displacement).
    4. Post-Processing: Removes fragmented tracks that fall below a minimum length 
       threshold after deduplication.

    Args:
        tracking_csv (str): Path to the input CSV file containing raw tracking data. 
            Expected columns: ['track_id', 'frame', 'conf', 'cx', 'cy'].
        output_csv (str): Path where the cleaned CSV will be saved.

    Returns:
        None: Saves the resulting DataFrame to output_csv.
    """
    df = pd.read_csv(tracking_csv)
    
    # 1. Calculate Statistics with Vectorized Physics
    stats = df.groupby('track_id').agg(
        duration=('frame', 'count'),
        start_f=('frame', 'min'),
        end_f=('frame', 'max'),
        m_conf=('conf', 'mean'),
        max_conf=('conf', 'max'),
        dist_x=('cx', lambda x: x.max() - x.min()),
        dist_y=('cy', lambda x: x.max() - x.min())
    )

    # Calculate Euclidean displacement
    stats['displacement'] = np.sqrt(stats['dist_x']**2 + stats['dist_y']**2)
    
    # Quality Score: Rewards movement and duration
    stats['quality_score'] = stats['duration'] * stats['m_conf'] * (stats['displacement'] + 1)

    # 2. Hard Noise Filtering
    is_noise = (
        (stats['displacement'] < 500) | # Static objects
        (stats['duration'] < 20) |      # Flickers
        ((stats['duration'] < 30) & (stats['max_conf'] < 0.6)) | # Short low-confidence tracks
        (stats['m_conf'] < 0.35) # Overall low-confidence tracks
    )
    valid_ids = stats[~is_noise].index 
    df = df[df['track_id'].isin(valid_ids)].copy() 

    # 3. Resolve Overlaps by Quality Score
    df = df.merge(stats[['quality_score']], on='track_id', how='left')
    df = df.sort_values(by=['frame', 'quality_score'], ascending=[True, False])
    
    # Keep only the best detection per frame
    df_cleaned = df.drop_duplicates(subset=['frame'], keep='first')

    # 4. Post-Process: Remove fragmented tracks left over after deduplication
    final_counts = df_cleaned['track_id'].value_counts()
    valid_final_tracks = final_counts[final_counts >= 5].index
    df_cleaned = df_cleaned[df_cleaned['track_id'].isin(valid_final_tracks)]

    # Final Sort
    df_cleaned = df_cleaned.sort_values('frame').drop(columns=['quality_score'])
    
    df_cleaned.to_csv(output_csv, index=False)