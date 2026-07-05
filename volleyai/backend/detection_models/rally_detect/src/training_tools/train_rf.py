from src.rally_predictor.rf_predictor import train_random_forest

def main():
    """
    Main execution script to train the Rally Prediction model.

    This script acts as the configuration layer for the training process. It 
    specifies the location of the final model artifact, the collection of 
    engineered feature files, and their corresponding manual ground-truth labels.

    Hyperparameters:
        num_est (300): We use 300 trees to ensure a stable majority vote 
            across diverse game scenarios.
        num_min_samples (50): By requiring 50 samples per leaf, we force the 
            model to learn general trends of a 'rally' rather than memorizing 
            specific frames, reducing overfitting.
    """
    # 1. PATH CONFIGURATION
    # The output filename for our trained Random Forest model (version 4)
    rf_model_path = "./models/rally_prediction/rally_predictor_rf_v4.pkl"
    
    # 2. DATASET DEFINITION
    # We include data from three different games to provide the model with 
    # a diverse set of examples (different serving styles, camera angles, etc.)
    feature_csvs = [
        "./output/training_data/game1_features.csv",
        "./output/training_data/game5_features.csv",
        "./output/training_data/game9_features.csv",
    ]
    
    # These must match the order of the feature_csvs list
    label_csvs = [
        "./output/training_data/game1_rally_labels_per_frame.csv",
        "./output/training_data/game5_rally_labels_per_frame.csv",
        "./output/training_data/game9_rally_labels_per_frame.csv",
    ]

    # 3. MODEL TRAINING
    # Launch the multi-game training pipeline
    train_random_forest(
        rf_model_path,
        feature_csvs,
        label_csvs,
        num_est=300,            # Increased from default for better stability
        num_min_samples=50      # Increased for stronger regularization
    )

if __name__ == "__main__":
    main()