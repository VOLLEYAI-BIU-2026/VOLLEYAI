# src/ball_detector/track_ball_detections.py

import pandas as pd
import numpy as np

import pandas as pd
import numpy as np

def track_with_physics_predictive(input_csv, output_csv, min_radius=50, max_radius=250, max_gap=60, velocity_margin=0.5):
    """
    Performs predictive object tracking by combining spatial proximity with constant velocity physics.

    This tracker assigns unique IDs to detections across frames. It predicts the expected 
    location of an object based on its last known velocity and searches for the nearest 
    detection within a dynamic radius. It also includes logic to identify and ignore 
    stationary 'noise' objects that persist across frames.

    Args:
        input_csv (str): Path to CSV containing raw detections (frame, x1, y1, x2, y2).
        output_csv (str): Path to save the tracked results.
        min_radius (int): The base search radius in pixels for slow-moving objects.
        max_radius (int): The maximum allowable search radius.
        max_gap (int): Maximum frames to keep a track alive without a new detection.
        velocity_margin (float): Multiplier to adjust the sensitivity of the dynamic 
            search range based on current speed.

    Returns:
        None: Writes the tracked data with 'track_id', 'vx', 'vy', and 'speed' to output_csv.
    """
    df = pd.read_csv(input_csv).sort_values('frame')
    
    # Pre-calculate centroids for distance math
    df['cx'] = (df['x1'] + df['x2']) / 2
    df['cy'] = (df['y1'] + df['y2']) / 2
    
    # Initialize tracking columns
    df['track_id'] = -1
    df['vx'] = 0.0
    df['vy'] = 0.0
    df['speed_px_frame'] = 0.0
    df['direction_deg'] = 0.0
    
    next_id = 0
    active_tracks = {} # Stores state: {tid: {last_pos, vx, vy, speed, last_f, etc.}}
    
    for f in sorted(df['frame'].unique()):
        frame_indices = df[df['frame'] == f].index.tolist()
        assigned_indices = []
        
        # Process existing tracks by most recent activity first
        sorted_tids = sorted(active_tracks.keys(), key=lambda x: active_tracks[x]['last_f'], reverse=True)
        
        for tid in sorted_tids:
            last_info = active_tracks[tid]
            
            # --- STATIONARY FILTERING ---
            # If a track has been flagged as static (e.g., a logo or chair), skip it
            if last_info.get('is_static', False):
                continue
                
            dt = f - last_info['last_f']
            
            # Remove track if it has been missing for too long
            if dt > max_gap:
                del active_tracks[tid]
                continue
            
            # 1. PREDICT POSITION
            # Linear motion model: P_new = P_old + (Velocity * Time_delta)
            curr_vx, curr_vy = last_info.get('vx', 0), last_info.get('vy', 0)
            curr_speed = last_info.get('speed', 0)
            
            pred_x = last_info['last_pos'][0] + (curr_vx * dt)
            pred_y = last_info['last_pos'][1] + (curr_vy * dt)
            
            # 2. DYNAMIC SEARCH RANGE
            # Search radius expands if the ball is moving fast to account for prediction error
            dynamic_threshold = min(min_radius + (3 * curr_speed * dt * velocity_margin), max_radius)
            
            best_dist, best_idx = dynamic_threshold, -1
            for idx in frame_indices:
                if idx in assigned_indices: 
                    continue
                
                # Euclidean distance between predicted point and actual detection
                dist = np.sqrt((pred_x - df.loc[idx, 'cx'])**2 + (pred_y - df.loc[idx, 'cy'])**2)
                if dist < best_dist:
                    best_dist, best_idx = dist, idx
            
            # 3. UPDATE TRACK STATE
            if best_idx != -1:
                new_pos = (df.loc[best_idx, 'cx'], df.loc[best_idx, 'cy'])
                
                # --- STATIONARY DETECTION LOGIC ---
                # Check how much the object actually moved from its previous location
                displacement = np.sqrt((new_pos[0] - last_info['last_pos'][0])**2 + 
                                       (new_pos[1] - last_info['last_pos'][1])**2)
                
                if displacement < 3:
                    stationary_count = last_info.get('stationary_count', 0) + 1
                else:
                    stationary_count = 0 # Object moved, reset counter
                
                # If object hasn't moved significantly for 30 frames, mark as static
                is_static = stationary_count >= 15
                
                # Update Velocity (pixels per frame)
                dx, dy = new_pos[0] - last_info['last_pos'][0], new_pos[1] - last_info['last_pos'][1]
                vx, vy = dx / dt, dy / dt
                speed = np.sqrt(vx**2 + vy**2)
                
                # Store results in DataFrame
                df.at[best_idx, 'track_id'] = tid
                df.at[best_idx, 'vx'], df.at[best_idx, 'vy'] = vx, vy
                df.at[best_idx, 'speed_px_frame'] = speed
                
                # Update track memory
                active_tracks[tid] = {
                    'last_f': f, 
                    'last_pos': new_pos,
                    'vx': vx, 'vy': vy, 'speed': speed,
                    'stationary_count': stationary_count,
                    'is_static': is_static
                }
                assigned_indices.append(best_idx)
        
        # 4. INITIALIZE NEW TRACKS
        # Any detections not assigned to an existing track start a new track_id
        for idx in frame_indices:
            if idx not in assigned_indices:
                df.at[idx, 'track_id'] = next_id
                active_tracks[next_id] = {
                    'last_f': f, 
                    'last_pos': (df.loc[idx, 'cx'], df.loc[idx, 'cy']),
                    'vx': 0.0, 'vy': 0.0, 'speed': 0.0,
                    'stationary_count': 0,
                    'is_static': False
                }
                next_id += 1
                
    df.to_csv(output_csv, index=False)
                
