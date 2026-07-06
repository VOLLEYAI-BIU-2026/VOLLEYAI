# src/rally_predictor/rf_predictor.py

import pandas as pd
import numpy as np
import joblib
import matplotlib.pyplot as plt
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    mean_absolute_error, accuracy_score, 
    confusion_matrix, ConfusionMatrixDisplay, classification_report
)

# List of continuous features used as input for the model
CONTS = ['mean_x', 'mean_y', 'std_x', 'std_y', 'mean_velocity', 'max_velocity', 'std_velocity',
         'mean_acceleration', 'mean_angle_change', 'mean_y_dominance', 'mean_accel_jitter', 
         'mean_energy', 'y_range_window', 'mean_vis', 'vis_std', 'is_low_window']
dep = "label"

def train_random_forest(rf_path, df_paths, labels_paths, num_est=200, num_min_samples=30):
    """
    Trains a Random Forest classifier to distinguish between 'Rally' and 'Downtime'.

    The function aggregates multiple feature and label files, performs categorical 
    encoding, trains the model, and generates evaluation metrics including a 
    Confusion Matrix and Feature Importance plot.

    Args:
        rf_path (str): File path where the trained model (.joblib) will be saved.
        df_paths (list of str): List of paths to the engineered feature CSV files.
        labels_paths (list of str): List of paths to the ground-truth label CSV files.
        num_est (int): Number of trees in the forest. Defaults to 200.
        num_min_samples (int): Minimum samples required to be at a leaf node. 
            Higher values help prevent overfitting to noise. Defaults to 30.

    Returns:
        None: Saves the model and displays evaluation plots.
    """
    combined_dfs = []
    
    # 1. DATA AGGREGATION
    # Iterate through pairs of feature and label files (one pair per video/clip)
    for df_p, labels_p in zip(df_paths, labels_paths):
        curr_features = pd.read_csv(df_p)
        curr_labels = pd.read_csv(labels_p)
        
        # Merge manual labels into the physics features
        curr_features['label'] = curr_labels['label']
        combined_dfs.append(curr_features)

    # Combine all individual game data into one master training set
    features_df = pd.concat(combined_dfs, ignore_index=True)
    features_df = features_df.fillna(0) # Handle edge cases with no movement

    # 2. PRE-PROCESSING
    # Split data: shuffle=False is used if the sequences are highly temporal, 
    # though for RF, shuffle=True is often safer for generalization.
    trn_df, val_df = train_test_split(features_df, test_size=0.25, shuffle=False)
    
    trn_df = trn_df.copy()
    val_df = val_df.copy()

    # Encode labels (e.g., 'Rally' -> 1, 'Downtime' -> 0)
    features_df[dep] = features_df[dep].astype('category')
    class_names = features_df[dep].cat.categories
    
    trn_df[dep] = pd.Categorical(trn_df[dep], categories=class_names).codes
    val_df[dep] = pd.Categorical(val_df[dep], categories=class_names).codes
    
    def xs_y(df):
        """Splits dataframe into feature matrix (X) and target vector (y)."""
        xs = df[CONTS].copy()
        return xs, df[dep] if dep in df else None

    trn_xs, trn_y = xs_y(trn_df)
    val_xs, val_y = xs_y(val_df)

    # 3. TRAINING
    # n_jobs=-1 utilizes all CPU cores for faster training
    rf = RandomForestClassifier(n_estimators=num_est, min_samples_leaf=num_min_samples, n_jobs=-1)
    rf.fit(trn_xs, trn_y)
    
    # 4. EVALUATION
    preds = rf.predict(val_xs)
    print(f"\n--- Model Evaluation ---")
    print(f"Validation MAE: {mean_absolute_error(val_y, preds):.4f}")
    print(f"Validation Accuracy: {accuracy_score(val_y, preds):.4f}")
    print("\nClassification Report:")
    print(classification_report(val_y, preds, target_names=[str(c) for c in class_names]))
    
    # 5. VISUALIZATION
    # Subplot 1: Confusion Matrix to see if we are misclassifying Downtime as Rally
    # Subplot 2: Feature importance to see which physics metrics are most predictive
    fig, ax = plt.subplots(1, 2, figsize=(15, 6))
    
    cm = confusion_matrix(val_y, preds)
    disp = ConfusionMatrixDisplay(confusion_matrix=cm, display_labels=class_names)
    disp.plot(ax=ax[0], cmap='Blues', values_format='d')
    ax[0].set_title("Confusion Matrix")

    importances = pd.Series(rf.feature_importances_, index=CONTS).sort_values(ascending=True)
    importances.tail(20).plot(kind='barh', ax=ax[1])
    ax[1].set_title("Top Feature Importances")
    
    plt.tight_layout()
    plt.show()
    
    # Save the model artifact for later use in the prediction function
    joblib.dump(rf, rf_path)
    print(f"Model saved to {rf_path}")

def predict_rallies(rf_path, df_path):
    """
    Loads a trained Random Forest model and predicts labels for new tracking data.

    Args:
        rf_path (str): Path to the saved .joblib model file.
        df_path (str): Path to the CSV containing features extracted from a new video.

    Returns:
        numpy.ndarray: Array of predicted class codes (e.g., [0, 1, 1, 0...]) 
            representing the state of each frame.
    """
    # Load the serialized model from disk
    rf_model = joblib.load(rf_path)
    
    # Read the features extracted from the target video
    features_df = pd.read_csv(df_path)
    features_df = features_df.fillna(0)
    
    # Ensure the feature columns match the training order defined in CONTS
    predictions = rf_model.predict(features_df[CONTS])
    
    return predictions