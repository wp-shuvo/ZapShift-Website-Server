const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5001;
require('dotenv').config();
const stripe = require('stripe')(process.env.PAYMENT_KEY);

const crypto = require('crypto');

const admin = require('firebase-admin');

// const serviceAccount = require('./zapShift-adnim-sdk.json');

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf8'
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = 'ZAP';

  // Format date: YYYYMMDD
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Generate 6-character hex code
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(cors());
app.use(express.json());
const verifyFBToken = async (req, res, next) => {
  // console.log('header in the middleware', req.headers.authorization);
  const fbToken = req.headers.authorization;
  if (!fbToken) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = fbToken.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log(decoded);
    req.decoded_email = decoded.email;

    next();
  } catch (error) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.0lr5e3w.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db('zapShiftDB');
    const userCollection = db.collection('users');
    const riderCollection = db.collection('riders');
    const parcelsCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');

    // midedleware more with database admin access

    const varifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      if (!user || user?.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    // user related apis

    // add a new user
    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await userCollection.findOne({ email });
      if (userExists) {
        return res.status(400).send({ message: 'user already exists' });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    //get all users
    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;

      const query = {};

      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } },
        ];
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = userCollection.find(query, options);
      const users = await cursor.toArray();
      res.send(users);
    });

    // get a single user
    app.get('/users/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await userCollection.findOne(query);
      res.send(result);
    });

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await userCollection.findOne(query);
      res.send({ role: result.role || 'user' });
    });

    //update user info
    app.patch(
      '/users/:id/role',
      verifyFBToken,
      varifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const role = req.body.role;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: role,
          },
        };
        const result = await userCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // reider related apis
    // add a new rider
    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();
      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });

    // get all riders
    // app.get('/riders', async (req, res) => {
    //   const { status, district, workStatus } = req.query;
    //   console.log(status, district, workStatus);
    //   const query = [];

    //   if (status) {
    //     query.status = req.query.status;
    //     // console.log(status, district, workStatus);
    //   }
    //   if (district) {
    //     query.district = req.query.district;
    //     // console.log(status, district, workStatus);
    //   }
    //   if (workStatus) {
    //     query.workStatus = req.query.workStatus;
    //     // console.log(status, district, workStatus);
    //   }

    //   const options = { sort: { createdAt: 1 } };
    //   const cursor = riderCollection.find({ query, options });
    //   const riders = await cursor.toArray();
    //   res.send(riders);
    // });

    app.get('/riders', async (req, res) => {
      const { status, riderDistrict, workStatus } = req.query;

      const query = {}; // must be an object

      if (status) {
        query.status = status;
      }
      if (riderDistrict) {
        query.riderDistrict = riderDistrict;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }

      // const options = { sort: { createdAt: 1 } };

      const cursor = riderCollection.find(query);
      const riders = await cursor.toArray();

      res.send(riders);
    });

    // update rider info
    app.patch('/riders/:id', verifyFBToken, varifyAdmin, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: 'available',
        },
      };
      const result = await riderCollection.updateOne(query, updateDoc);

      if (status === 'approved') {
        const email = req.body.email;
        const filter = { email: email };
        const updateDoc = { $set: { role: 'rider' } };
        const result = await userCollection.updateOne(filter, updateDoc);
      }
      res.send(result);
    });

    // delete rider
    app.delete('/riders/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await riderCollection.deleteOne(query);
      res.send(result);
    });

    //parcels API

    // Add a new parcel
    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      console.log(parcel);
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });
    // Get all parcels
    app.get('/parcels', async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const parcels = await cursor.toArray();
      res.send(parcels);
    });
    //
    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });
    // update parcel info
    app.patch('/parcels/:id', async (req, res) => {
      const { riderName, riderEmail, riderId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: 'deliver-assigned',
          riderName: riderName,
          riderEmail: riderEmail,
          riderId: riderId,
        },
      };
      const result = await parcelsCollection.updateOne(query, updateDoc);
      // update rider info
      const riderQuery = { _id: new ObjectId(riderId) };
      const updateRiderDoc = {
        $set: {
          workStatus: 'in-delivery',
        },
      };
      const riderResult = await riderCollection.updateOne(
        riderQuery,
        updateRiderDoc
      );

      res.send({ parcel: result, rider: riderResult });
    });

    // parcel delete
    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelsCollection.deleteOne(query);
      res.status(200).send(result);
    });

    // payments related apis
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      console.log(session);
      res.send({ url: session.url });
    });
    //  payment success old
    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log('session retrieve', session);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const payment = await paymentCollection.findOne(query);

      if (payment) {
        res.send({
          message: 'payment already done',
          transactionId: transactionId,
          trackingId: payment.trackingId,
        });
        return;
      }
      const trackingId = generateTrackingId();

      if (session.payment_status === 'paid') {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: 'paid',
            deliveryStatus: 'pending-pickup',
            trackingId: trackingId,
          },
        };

        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === 'paid') {
          const resultPayment = await paymentCollection.insertOne(payment);

          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }
      res.send({ success: false });
    });

    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        // check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: 'unauthorized access' });
        }
      }

      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const payments = await cursor.toArray();
      res.send(payments);
    });

    // Send a ping to confirm a successful connection
    // await client.db('admin').command({ ping: 1 });
    // console.log(
    //   'Pinged your deployment. You successfully connected to MongoDB!'
    // );
  } finally {
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Zap Shift server is runing!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
