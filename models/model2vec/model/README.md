---
library_name: model2vec
license: mit
tags:
- embeddings
- static-embeddings
- mteb
- sentence-transformers
---

# potion-base-8M Model Card

<div align="center">
  <img width="35%" alt="Model2Vec logo" src="https://raw.githubusercontent.com/MinishLab/model2vec/main/assets/images/logo_v2.png">
</div>


This [Model2Vec](https://github.com/MinishLab/model2vec) model is pre-trained using [Tokenlearn](https://github.com/MinishLab/tokenlearn). It is a distilled version of the [baai/bge-base-en-v1.5](https://huggingface.co/baai/bge-base-en-v1.5) Sentence Transformer. It uses static embeddings, allowing text embeddings to be computed orders of magnitude faster on both GPU and CPU. It is designed for applications where computational resources are limited or where real-time performance is critical.



## Installation

Install model2vec using pip:
```
pip install model2vec
```

## Usage
Load this model using the `from_pretrained` method:
```python
from model2vec import StaticModel

# Load a pretrained Model2Vec model
model = StaticModel.from_pretrained("minishlab/potion-base-8M")

# Compute text embeddings
embeddings = model.encode(["Example sentence"])
```


## How it works

Model2vec creates a small, static model that outperforms other static embedding models by a large margin on all tasks on [MTEB](https://huggingface.co/spaces/mteb/leaderboard). This model is pre-trained using [Tokenlearn](https://github.com/MinishLab/tokenlearn). It's created using the following steps:
- Distillation: first, a model is distilled from a sentence transformer model using Model2Vec.
- Training data creation: the sentence transformer model is used to create training data by creating mean output embeddings on a large corpus.
- Training: the distilled model is trained on the training data using Tokenlearn.
- Post-training re-regularization: after training, the model is re-regularized by weighting the tokens based on their frequency, applying PCA, and finally applying [SIF weighting](https://openreview.net/pdf?id=SyK00v5xx).

The results for this model can be found on the [Model2Vec results page](https://github.com/MinishLab/model2vec/blob/main/results/README.md).

## Additional Resources

- [All Model2Vec models on the hub](https://huggingface.co/models?library=model2vec)
- [Model2Vec Repo](https://github.com/MinishLab/model2vec)
- [Tokenlearn repo](https://github.com/MinishLab/tokenlearn)
- [Model2Vec Results](https://github.com/MinishLab/model2vec/blob/main/results/README.md)
- [Model2Vec Tutorials](https://github.com/MinishLab/model2vec/tree/main/tutorials)

## Library Authors

Model2Vec was developed by the [Minish Lab](https://github.com/MinishLab) team consisting of [Stephan Tulkens](https://github.com/stephantul) and [Thomas van Dongen](https://github.com/Pringled).

## Citation

Please cite the [Model2Vec repository](https://github.com/MinishLab/model2vec) if you use this model in your work.
```
@software{minishlab2024model2vec,
  authors = {Stephan Tulkens, Thomas van Dongen},
  title = {Model2Vec: Turn any Sentence Transformer into a Small Fast Model},
  year = {2024},
  url = {https://github.com/MinishLab/model2vec},
}
```